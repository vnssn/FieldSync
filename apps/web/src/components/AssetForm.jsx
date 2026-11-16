import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createAssetSchema, updateAssetSchema, assetSchema } from '@fieldsync/contracts';
import { apiRequest } from '../api/client.js';
import { ErrorNotice, Field, formErrors } from './ui.jsx';

export function AssetForm({ asset, onDone, onCancel }) {
  const [errors, setErrors] = useState({});
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: (body) => apiRequest(asset ? `/assets/${asset.id}` : '/assets', {
      method: asset ? 'PATCH' : 'POST', body, schema: assetSchema,
    }),
    onSuccess: async (saved) => {
      await client.invalidateQueries({ queryKey: ['assets'] });
      await client.invalidateQueries({ queryKey: ['asset', saved.organizationId, saved.id] });
      onDone(saved);
    },
  });
  function submit(event) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const result = (asset ? updateAssetSchema : createAssetSchema).safeParse(asset ? { ...values, baseVersion: asset.version } : values);
    if (!result.success) { setErrors(formErrors(result)); return; }
    setErrors({}); mutation.mutate(result.data);
  }
  return <form onSubmit={submit} className="panel mb-6 space-y-5">
    <h2 className="text-xl font-semibold text-[#203c33]">{asset ? 'Edit asset' : 'New asset'}</h2>
    <ErrorNotice error={mutation.error} />
    <div className="grid gap-5 sm:grid-cols-2">
      {[['code', 'Asset code', 64], ['name', 'Asset name', 160], ['category', 'Category', 100], ['location', 'Location', 240]].map(([name, label, maxLength]) =>
        <Field key={name} label={label} name={name} errors={errors} defaultValue={asset?.[name] ?? ''} required maxLength={maxLength} />)}
    </div>
    {asset && <label className="block text-sm font-medium text-stone-700">Status
      <select className="input mt-2" name="status" defaultValue={asset.status}><option value="active">Active</option><option value="archived">Archived</option></select>
    </label>}
    <div className="flex gap-3"><button className="button-primary" disabled={mutation.isPending}>{mutation.isPending ? 'Saving…' : 'Save asset'}</button>
      <button type="button" className="button-secondary" disabled={mutation.isPending} onClick={onCancel}>Cancel</button></div>
  </form>;
}
