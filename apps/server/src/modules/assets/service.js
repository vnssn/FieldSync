import { randomUUID } from 'node:crypto';
import { assetChangesSchema, assetDetailSchema } from '@fieldsync/contracts';
import { transaction } from '../../infrastructure/transaction.js';
import { HttpError } from '../../http/errors.js';
import { assertAdmin } from '../auth/middleware.js';
import { listAssets, findAsset, insertAsset, updateAsset, insertEvent, listEvents } from './repository.js';

const fields = ['code', 'name', 'category', 'location', 'status'];
function changesBetween(before, after) {
  return assetChangesSchema.parse(Object.fromEntries(fields
    .filter((key) => before?.[key] !== after[key])
    .map((key) => [key, { before: before?.[key] ?? null, after: after[key] }])));
}

export function createAssetsService(pool) {
  return {
    list(auth, query) {
      return listAssets(pool, auth.organizationId, query);
    },
    detail(auth, id) {
      return transaction(pool, async (db) => {
        const asset = await findAsset(db, auth.organizationId, id);
        if (!asset) throw new HttpError(404, 'ASSET_NOT_FOUND', 'Asset not found.');
        return assetDetailSchema.parse({ asset, events: await listEvents(db, auth.organizationId, id) });
      }, { readOnly: true });
    },
    create(auth, input) {
      assertAdmin(auth);
      return transaction(pool, async (db) => {
        const asset = await insertAsset(db, {
          id: randomUUID(), organizationId: auth.organizationId, userId: auth.user.id, input,
        });
        await insertEvent(db, {
          id: randomUUID(), organizationId: auth.organizationId, assetId: asset.id,
          userId: auth.user.id, eventType: 'created', changes: changesBetween(null, asset),
        });
        return asset;
      });
    },
    update(auth, id, input) {
      assertAdmin(auth);
      return transaction(pool, async (db) => {
        const previous = await findAsset(db, auth.organizationId, id, { lock: true });
        if (!previous) throw new HttpError(404, 'ASSET_NOT_FOUND', 'Asset not found.');
        if (previous.version !== input.baseVersion) {
          throw new HttpError(409, 'VERSION_CONFLICT', 'This asset changed. Reload its latest details before saving.');
        }
        const next = { ...previous, ...input };
        const changes = changesBetween(previous, next);
        if (!Object.keys(changes).length) throw new HttpError(400, 'NO_CHANGES', 'No asset fields have changed.');
        const eventType = changes.status ? (next.status === 'archived' ? 'archived' : 'restored') : 'updated';
        const asset = await updateAsset(db, auth.organizationId, id, next);
        if (!asset) throw new HttpError(409, 'VERSION_CONFLICT', 'This asset changed. Reload before saving.');
        await insertEvent(db, {
          id: randomUUID(), organizationId: auth.organizationId, assetId: id, userId: auth.user.id,
          eventType, changes,
        });
        return asset;
      });
    },
  };
}
