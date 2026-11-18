import { Writable } from 'node:stream';

// Simulate the SDK and private byte transport; never contact a cloud account.
export function cloudinaryFixture() {
  const assets = new Map(), calls = [];
  const sdk = {
    uploader: {
      upload_stream(options,callback) {
        calls.push({ action:'upload',options });
        const chunks = [];
        return new Writable({ write(chunk,_encoding,done) { chunks.push(Buffer.from(chunk)); done(); },
          final(done) {
            const previous = assets.get(options.public_id);
            const bytes = previous?.bytes ?? Buffer.concat(chunks);
            assets.set(options.public_id,{ bytes,created_at:previous?.created_at ?? new Date().toISOString() });
            callback(null,{ public_id:options.public_id,resource_type:options.resource_type,type:options.type,bytes:bytes.length }); done();
          } });
      },
      async destroy(id,options) { calls.push({ action:'delete',id,options }); return { result:assets.delete(id)?'ok':'not found' }; },
    },
    utils: { private_download_url(id,format,options) {
      calls.push({ action:'download',id,format,options });
      return `https://api.cloudinary.example.test/raw/download?public_id=${encodeURIComponent(id)}`;
    } },
    api: { async resources(options) {
      calls.push({ action:'list',options });
      const all = [...assets].filter(([id]) => id.startsWith(options.prefix)),start = Number(options.next_cursor ?? 0);
      // Small pages exercise pagination during cleanup tests.
      const page = all.slice(start,start+2);
      return { resources:page.map(([public_id,asset]) => ({ public_id,created_at:asset.created_at,resource_type:'raw',type:'authenticated' })),
        next_cursor:start+2<all.length ? String(start+2):undefined };
    } },
  };
  const fetchFile = async (url,options) => {
    calls.push({ action:'fetch',options });
    const asset = assets.get(new URL(url).searchParams.get('public_id'));
    return asset ? new Response(asset.bytes,{ headers:{ 'content-length':String(asset.bytes.length),'content-type':'application/octet-stream' } }):new Response(null,{ status:404 });
  };
  return { sdk,fetchFile,assets,calls };
}

export const cloudinarySettings = { EVIDENCE_STORAGE_PROVIDER:'cloudinary',APP_ORIGIN:'https://fieldsync.example.test',
  CLOUDINARY_CLOUD_NAME:'test-cloud',CLOUDINARY_API_KEY:'test-api-key',CLOUDINARY_API_SECRET:'synthetic-cloudinary-test-secret',CLOUDINARY_FOLDER:'fieldsync-test' };
