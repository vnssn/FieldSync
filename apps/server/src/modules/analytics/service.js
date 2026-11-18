import { analyticsSchema, INSPECTION_STATUSES } from '@fieldsync/contracts';
import { transaction } from '../../infrastructure/transaction.js';
import { HttpError } from '../../http/errors.js';

function count(value) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('Analytics count out of range');
  return result;
}
export function createAnalyticsService(pool) {
  return {
    summary(auth, query) {
      return transaction(pool, async (db) => {
        const workerId = auth.user.role === 'worker' ? auth.user.id : null;
        const asOf = (await db.query('SELECT current_timestamp AS value')).rows[0].value;
        const since = new Date(asOf); since.setUTCHours(0,0,0,0); since.setUTCDate(since.getUTCDate() - Number(query.days) + 1);
        const values = [auth.organizationId,workerId,query.assetId ?? null,since,asOf];
        const scope = `organization_id=$1 AND ($2::uuid IS NULL OR assigned_to=$2) AND ($3::uuid IS NULL OR asset_id=$3)`;
        if (query.assetId) {
          const asset = await db.query(`SELECT 1 FROM assets a WHERE organization_id=$1 AND id=$3
            AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM inspections i WHERE i.organization_id=a.organization_id AND i.asset_id=a.id AND i.assigned_to=$2))`, values.slice(0,3));
          if (!asset.rowCount) throw new HttpError(404,'ASSET_NOT_FOUND','Asset not found in this analytics scope.');
        }
        const assets = (await db.query(`SELECT count(*) AS total,count(*) FILTER (WHERE status='active') AS active,count(*) FILTER (WHERE status='archived') AS archived
          FROM assets a WHERE a.organization_id=$1 AND ($3::uuid IS NULL OR a.id=$3)
          AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM inspections i WHERE i.organization_id=a.organization_id AND i.asset_id=a.id AND i.assigned_to=$2))`, values.slice(0,3))).rows[0];
        const states = await db.query(`SELECT status,count(*) AS total FROM inspections WHERE ${scope} AND created_at>=$4 AND created_at<=$5 GROUP BY status`,values);
        const byStatus = Object.fromEntries(Object.values(INSPECTION_STATUSES).map((status) => [status,0]));
        for (const row of states.rows) byStatus[row.status] = count(row.total);
        const totals = (await db.query(`SELECT
          coalesce(sum((SELECT count(*) FROM jsonb_array_elements(i.answers) answer WHERE answer->>'outcome'='fail')),0) AS failed,
          avg(greatest(0,extract(epoch FROM (i.submitted_at-i.created_at)))/3600) FILTER (WHERE i.submitted_at IS NOT NULL) AS hours
          FROM inspections i WHERE ${scope} AND created_at>=$4 AND created_at<=$5`,values)).rows[0];
        const activity = await db.query(`WITH scoped AS (SELECT created_at,submitted_at FROM inspections WHERE ${scope}),
          dates AS (SELECT generate_series($4::timestamptz AT TIME ZONE 'UTC', $5::timestamptz AT TIME ZONE 'UTC', interval '1 day')::date AS date)
          SELECT to_char(d.date,'YYYY-MM-DD') AS date,
            (SELECT count(*) FROM scoped s WHERE (s.created_at AT TIME ZONE 'UTC')::date=d.date AND s.created_at<=$5) AS created,
            (SELECT count(*) FROM scoped s WHERE (s.submitted_at AT TIME ZONE 'UTC')::date=d.date AND s.submitted_at<=$5) AS submitted
          FROM dates d ORDER BY d.date`,values);
        const perAsset = await db.query(`WITH scoped AS (SELECT * FROM inspections WHERE ${scope} AND created_at>=$4 AND created_at<=$5),
          stats AS (SELECT asset_id,count(*) AS inspections,count(*) FILTER (WHERE status='submitted') AS submitted,
            count(*) FILTER (WHERE status='approved') AS approved,
            coalesce(sum((SELECT count(*) FROM jsonb_array_elements(i.answers) answer WHERE answer->>'outcome'='fail')),0) AS failed
            FROM scoped i GROUP BY asset_id)
          SELECT a.id,a.code,a.name,a.status,coalesce(s.inspections,0) AS inspections,coalesce(s.submitted,0) AS submitted,
            coalesce(s.approved,0) AS approved,coalesce(s.failed,0) AS failed
          FROM assets a LEFT JOIN stats s ON s.asset_id=a.id
          WHERE a.organization_id=$1 AND ($3::uuid IS NULL OR a.id=$3)
            AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM inspections i WHERE i.organization_id=a.organization_id AND i.asset_id=a.id AND i.assigned_to=$2))
          ORDER BY failed DESC,inspections DESC,a.code,a.id LIMIT 50`,values);
        return analyticsSchema.parse({ scope: workerId ? 'assigned':'workspace',days:Number(query.days),since:since.toISOString(),asOf:asOf.toISOString(),
          assets: { total:count(assets.total),active:count(assets.active),archived:count(assets.archived) },
          inspections: { total:Object.values(byStatus).reduce((total,value) => total+value,0),byStatus,failedChecks:count(totals.failed),
            averageSubmissionHours:totals.hours === null ? null : Math.round(Number(totals.hours)*100)/100 },
          activity:activity.rows.map((row) => ({ date:row.date,created:count(row.created),submitted:count(row.submitted) })),
          byAsset:perAsset.rows.map((row) => ({ id:row.id,code:row.code,name:row.name,status:row.status,inspections:count(row.inspections),
            submitted:count(row.submitted),approved:count(row.approved),failedChecks:count(row.failed) })),
        });
      }, { readOnly:true });
    },
  };
}
