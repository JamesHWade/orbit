import {
  AttachmentReference,
  Entity,
  EntityID,
  EntityType,
  Event,
  EventID,
  IDOfEntity,
  Task,
} from "@withorbit/core2";
import {
  DatabaseBackend,
  DatabaseBackendEntityRecord,
  DatabaseEntityQuery,
  DatabaseEventQuery,
  DatabaseQueryPredicate,
} from "@withorbit/store-shared";
import { firestore } from "firebase-admin";
import { getDatabase } from "./firebase";
import { getFirebaseKeyFromStringHash } from "./firebaseSupport/firebaseKeyEncoding";
import { compareOrderedIDs, OrderedID, OrderedIDGenerator } from "./orderedID";

export class FirestoreDatabaseBackend implements DatabaseBackend {
  private readonly _userID: string;
  private readonly _database: firestore.Firestore;
  private readonly _orderedIDGenerator: OrderedIDGenerator;

  constructor(userID: string, database: firestore.Firestore = getDatabase()) {
    this._userID = userID;
    this._database = database;
    this._orderedIDGenerator = new OrderedIDGenerator();
  }

  async close(): Promise<void> {
    await this._database.terminate();
  }

  async getEntities<E extends Entity, ID extends IDOfEntity<E>>(
    entityIDs: ID[],
  ): Promise<Map<ID, DatabaseBackendEntityRecord<E>>> {
    const docs = await this._getByID<EntityDocumentBase<E>>(
      this._getEntityCollectionRef<EntityDocumentBase<E>>(),
      entityIDs,
      (ids) => this._database.getAll(...ids),
    );
    return getEntityRecordMapFromFirestoreDocs<E, ID>(docs);
  }

  async getEvents<E extends Event, ID extends EventID>(
    eventIDs: ID[],
  ): Promise<Map<ID, E>> {
    const docs = await this._getByID(
      this._getEventCollectionRef<E>(),
      eventIDs,
      (ids) => this._database.getAll(...ids),
    );
    const output = new Map<ID, E>();
    for (const doc of docs) {
      if (doc) {
        output.set(doc.event.id as ID, doc.event);
      }
    }
    return output;
  }

  async listEntities<E extends Entity>(
    query: DatabaseEntityQuery<E>,
  ): Promise<DatabaseBackendEntityRecord<E>[]> {
    // Using the template string type here just to enforce that the key path I'm using here is indeed a valid key path into the Entity type. Though I can't enforce that the value at that key is actually an EntityType.
    const entityTypeKeyPath: `${EntityDocumentKey.Entity}.${keyof Entity}` =
      `${EntityDocumentKey.Entity}.type` as const;

    const docs = await this._listDocuments<
      EntityDocumentBase<E>,
      EntityDocumentKey | TaskDocumentKey,
      DatabaseEntityQuery<E>,
      IDOfEntity<E>
    >({
      query,
      baseFirestoreQuery: this._getEntityCollectionRef().where(
        entityTypeKeyPath,
        "==",
        query.entityType,
      ) as firestore.Query<EntityDocumentBase<E>>,
      getDocRefByObjectID: (id) =>
        this._getEntityRef<EntityDocumentBase<E>>(id),
      orderedIDKey: EntityDocumentKey.OrderedID,
      getDocKeyForQueryPredicate: (predicate) =>
        ({
          dueTimestampMillis: TaskDocumentKey.MinimumDueTimestampMillis,
        }[predicate[0]]),
      getDocOrderedID: (doc) => doc.orderedID,
      getDocObjectID: (doc) =>
        doc[EntityDocumentKey.Entity].id as IDOfEntity<E>,
    });
    return docs.map((doc) => getEntityRecordFromFirestoreDoc(doc));
  }

  async listEvents(query: DatabaseEventQuery): Promise<Event[]> {
    const docs = await this._listDocuments<
      EventDocument,
      EventDocumentKeyPath,
      DatabaseEventQuery,
      EventID
    >({
      query,
      baseFirestoreQuery: this._getEventCollectionRef(),
      getDocRefByObjectID: (id) => this._getEventRef(id),
      orderedIDKey: EventDocumentKey.OrderedID,
      getDocKeyForQueryPredicate: (predicate) =>
        ((
          {
            entityID: `${EventDocumentKey.Event}.entityID`,
          } as const
        )[predicate[0]]),
      getDocOrderedID: (doc) => doc.orderedID,
      getDocObjectID: (doc) => doc[EventDocumentKey.Event].id,
    });
    return docs.map((doc) => doc.event);
  }

  private async _listDocuments<
    D extends EntityDocumentBase | EventDocument,
    DK extends D extends EntityDocumentBase<any>
      ? EntityDocumentKey | TaskDocumentKey
      : EventDocumentKeyPath,
    Q extends D extends EntityDocumentBase<infer ET>
      ? DatabaseEntityQuery<ET>
      : DatabaseEventQuery,
    OID extends D extends EntityDocumentBase<infer ET>
      ? IDOfEntity<ET>
      : EventID,
  >({
    query,
    orderedIDKey,
    baseFirestoreQuery,
    getDocRefByObjectID,
    getDocKeyForQueryPredicate,
    getDocOrderedID,
    getDocObjectID,
  }: {
    query: Q;
    orderedIDKey: DK;
    baseFirestoreQuery: firestore.Query<D>;
    getDocRefByObjectID: (id: OID) => firestore.DocumentReference<D>;
    getDocKeyForQueryPredicate: (
      predicate: Exclude<Q["predicate"], undefined>,
    ) => DK;
    getDocOrderedID: (doc: D) => OrderedID;
    getDocObjectID: (doc: D) => OID;
  }): Promise<D[]> {
    const afterDocumentSnapshot = query.afterID
      ? await getDocRefByObjectID(query.afterID as OID).get()
      : null;
    if (afterDocumentSnapshot && !afterDocumentSnapshot.exists) {
      throw new Error(`Unknown afterID ${query.afterID}`);
    }

    if (query.predicate) {
      baseFirestoreQuery = baseFirestoreQuery.where(
        getDocKeyForQueryPredicate(
          query.predicate as Exclude<Q["predicate"], undefined>,
        ),
        mapQueryPredicateToFirestoreOp(query.predicate),
        query.predicate[2],
      );
    }

    let docs: firestore.DocumentSnapshot<D>[];
    // So long as there's no predicate, or the predicate is simple equality, we can arrange our indexes to support efficient query and ordering by OrderedID. But if it's a range predicate, we have to use an index based just on the predicate key, then do an in-memory sort, offset, and limit on the OrderedID. This makes paging quadratic in time cost.
    if (!query.predicate || query.predicate[1] === "=") {
      baseFirestoreQuery = baseFirestoreQuery.orderBy(orderedIDKey);
      if (query.afterID) {
        baseFirestoreQuery = baseFirestoreQuery.startAfter(
          afterDocumentSnapshot,
        );
      }
      if (query.limit !== undefined) {
        baseFirestoreQuery = baseFirestoreQuery.limit(query.limit);
      }
      docs = (await baseFirestoreQuery.get()).docs;
    } else {
      baseFirestoreQuery = baseFirestoreQuery.orderBy(
        getDocKeyForQueryPredicate(
          query.predicate as Exclude<Q["predicate"], undefined>,
        ),
      );

      const allDocsMatchingPredicate = (await baseFirestoreQuery.get()).docs;

      allDocsMatchingPredicate.sort((a, b) =>
        compareOrderedIDs(getDocOrderedID(a.data()), getDocOrderedID(b.data())),
      );
      if (afterDocumentSnapshot) {
        const afterDocIndex = allDocsMatchingPredicate.findIndex(
          (doc) => getDocObjectID(doc.data()) === query.afterID,
        );
        if (afterDocIndex === -1) {
          throw new Error(
            `afterID document unexpectedly disappeared: ${query.afterID}`,
          );
        }
        docs = allDocsMatchingPredicate.slice(
          afterDocIndex + 1,
          query.limit === undefined
            ? undefined
            : afterDocIndex + 1 + query.limit,
        );
      } else if (query.limit === undefined) {
        docs = allDocsMatchingPredicate;
      } else {
        docs = allDocsMatchingPredicate.slice(0, query.limit);
      }
    }

    return docs.map((doc) => doc.data()!);
  }

  async modifyEntities<E extends Entity, ID extends IDOfEntity<E>>(
    ids: ID[],
    transformer: (
      entityRecordMap: Map<ID, DatabaseBackendEntityRecord<E>>,
    ) => Promise<Map<ID, DatabaseBackendEntityRecord<E>>>,
  ): Promise<void> {
    await this._database.runTransaction(async (tx) => {
      // Get the old entity records.
      const entityDocs = await this._getByID<EntityDocumentBase<E>>(
        this._getEntityCollectionRef(),
        ids,
        (ids) => tx.getAll(...ids),
      );

      // Call the transformer.
      const newEntityRecordMap = await transformer(
        getEntityRecordMapFromFirestoreDocs<E, ID>(entityDocs),
      );

      // Save the new entity records.
      const entityCollectionRef = this._getEntityCollectionRef();
      const orderedIDsByEntityID = new Map<ID, OrderedID>();
      for (const doc of entityDocs) {
        if (doc) {
          orderedIDsByEntityID.set(doc.entity.id as ID, doc.orderedID);
        }
      }
      for (const [id, newRecord] of newEntityRecordMap) {
        const ref = this._getEntityRef(id, entityCollectionRef);
        tx.set(
          ref,
          getEntityDocumentFromRecord(
            newRecord,
            orderedIDsByEntityID.get(id) ??
              this._orderedIDGenerator.getOrderedID(),
          ),
        );
      }
    });
  }

  async putEvents(events: Event[]): Promise<void> {
    const eventCollectionRef = this._getEventCollectionRef();
    await this._database.runTransaction(async (tx) => {
      // We only want to insert events that don't exist, so we fetch just the metadata for all the IDs specified.
      const eventSnapshots = await tx.getAll(
        ...events.map(({ id }) => this._getEventRef(id, eventCollectionRef)),
        { fieldMask: [] },
      );

      for (let i = 0; i < events.length; i++) {
        const snapshot = eventSnapshots[i];
        if (!snapshot.exists) {
          tx.create(snapshot.ref, {
            orderedID: this._orderedIDGenerator.getOrderedID(),
            event: events[i],
          });
        }
      }
    });
  }

  private async _getByID<D extends EntityDocumentBase | EventDocument>(
    collectionRef: firestore.CollectionReference<D>,
    ids: string[],
    getAllImpl: (
      refs: firestore.DocumentReference[],
    ) => Promise<firestore.DocumentSnapshot[]>,
  ): Promise<(D | null)[]> {
    const refs = ids.map((id) =>
      collectionRef.doc(getFirebaseKeyFromStringHash(id)),
    );
    const eventSnapshots = await getAllImpl(refs);
    return eventSnapshots.map((snapshot) =>
      snapshot.exists ? (snapshot.data()! as D) : null,
    );
  }

  private _getUserDocumentRef() {
    return this._database.collection("users").doc(this._userID);
  }

  private _getEventCollectionRef<
    E extends Event = Event,
  >(): firestore.CollectionReference<EventDocument<E>> {
    return this._getUserDocumentRef().collection(
      "events",
    ) as firestore.CollectionReference<EventDocument<E>>;
  }

  private _getEntityCollectionRef<
    D extends EntityDocumentBase,
  >(): firestore.CollectionReference<D> {
    return this._getUserDocumentRef().collection(
      "entities",
    ) as firestore.CollectionReference<D>;
  }

  private _getEventRef<E extends Event = Event>(
    eventID: EventID,
    collection = this._getEventCollectionRef(),
  ): firestore.DocumentReference<EventDocument<E>> {
    return collection.doc(
      getFirebaseKeyFromStringHash(eventID),
    ) as firestore.DocumentReference<EventDocument<E>>;
  }

  private _getEntityRef<D extends EntityDocumentBase>(
    entityID: EntityID,
    collection = this._getEntityCollectionRef(),
  ): firestore.DocumentReference<D> {
    return collection.doc(
      getFirebaseKeyFromStringHash(entityID),
    ) as firestore.DocumentReference<D>;
  }
}

enum EventDocumentKey {
  OrderedID = "orderedID",
  Event = "event",
}

type EventDocumentKeyPath =
  | EventDocumentKey
  | `${EventDocumentKey.Event}.${keyof Event}`;

interface EventDocument<E extends Event = Event> {
  [EventDocumentKey.OrderedID]: OrderedID;
  [EventDocumentKey.Event]: E;
}

type EntityDocument = TaskDocument | EntityDocumentBase<AttachmentReference>;

enum EntityDocumentKey {
  OrderedID = "orderedID",
  Entity = "entity",
}
interface EntityDocumentBase<E extends Entity = Entity>
  extends DatabaseBackendEntityRecord<E> {
  [EntityDocumentKey.OrderedID]: OrderedID;
  [EntityDocumentKey.Entity]: E;
}

enum TaskDocumentKey {
  MinimumDueTimestampMillis = "minimumDueTimestampMillis",
}

interface TaskDocument extends EntityDocumentBase<Task> {
  [TaskDocumentKey.MinimumDueTimestampMillis]: number; // i.e. minimum over all task components, used for queries
}

function getEntityRecordFromFirestoreDoc<E extends Entity>(
  doc: EntityDocumentBase<E>,
): DatabaseBackendEntityRecord<E> {
  return {
    entity: doc.entity as E,
    lastEventTimestampMillis: doc.lastEventTimestampMillis,
    lastEventID: doc.lastEventID,
  };
}

function getEntityRecordMapFromFirestoreDocs<
  E extends Entity,
  ID extends IDOfEntity<E>,
>(
  docs: (EntityDocumentBase<E> | null)[],
): Map<ID, DatabaseBackendEntityRecord<E>> {
  const output = new Map<ID, DatabaseBackendEntityRecord<E>>();
  for (const doc of docs) {
    if (doc) {
      output.set(doc.entity.id as ID, getEntityRecordFromFirestoreDoc(doc));
    }
  }
  return output;
}

function getEntityDocumentFromRecord<E extends Entity>(
  newRecord: DatabaseBackendEntityRecord<E>,
  orderedID: OrderedID,
): EntityDocument {
  const entity: Entity = newRecord.entity;
  const entityDocumentBase: EntityDocumentBase = {
    entity: entity,
    lastEventID: newRecord.lastEventID,
    lastEventTimestampMillis: newRecord.lastEventTimestampMillis,
    orderedID,
  };

  let newDocument: EntityDocument;
  switch (entity.type) {
    case EntityType.Task:
      const minimumDueTimestampMillis = Math.min(
        ...Object.values(entity.componentStates).map(
          ({ dueTimestampMillis }) => dueTimestampMillis,
        ),
      );
      if (isNaN(minimumDueTimestampMillis)) {
        throw new Error(
          `Unexpected component-less entity: ${JSON.stringify(entity)}`,
        );
      }
      newDocument = {
        ...entityDocumentBase,
        entity: entity,
        minimumDueTimestampMillis,
      };
      break;
    case EntityType.AttachmentReference:
      newDocument = { ...entityDocumentBase, entity: entity };
      break;
  }
  return newDocument;
}

function mapQueryPredicateToFirestoreOp(
  predicate: DatabaseQueryPredicate<any, any, any>,
): FirebaseFirestore.WhereFilterOp {
  return predicate[1] === "=" ? "==" : predicate[1];
}
