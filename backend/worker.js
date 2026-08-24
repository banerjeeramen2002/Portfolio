export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': env.APP_ORIGIN || '*',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
    };
    if (request.method === 'OPTIONS') return new Response(null,{headers:cors});

    const json = (data,status=200)=>new Response(JSON.stringify(data),{status,headers:{...cors,'content-type':'application/json'}});

    if (url.pathname === '/api/instagram/status') {
      return json({connected: !!(env.IG_USER_ID && env.IG_ACCESS_TOKEN)});
    }

    if (url.pathname === '/api/instagram/connect') {
      if (!env.META_APP_ID || !env.OAUTH_REDIRECT_URI) return json({error:'Meta app is not configured'},503);
      const returnTo = url.searchParams.get('return') || env.APP_ORIGIN || '/';
      const state = btoa(JSON.stringify({returnTo,ts:Date.now()}));
      const auth = new URL('https://www.instagram.com/oauth/authorize');
      auth.searchParams.set('client_id', env.META_APP_ID);
      auth.searchParams.set('redirect_uri', env.OAUTH_REDIRECT_URI);
      auth.searchParams.set('response_type','code');
      auth.searchParams.set('scope','instagram_business_basic,instagram_business_content_publish');
      auth.searchParams.set('state',state);
      return Response.redirect(auth.toString(),302);
    }

    if (url.pathname === '/api/instagram/callback') {
      return json({error:'OAuth callback needs token exchange + secure token storage configured for the deployed environment.'},501);
    }

    if (url.pathname === '/api/instagram/schedule' && request.method === 'POST') {
      if (!env.IG_USER_ID || !env.IG_ACCESS_TOKEN) return json({ok:false,error:'Instagram not connected'},401);
      const form = await request.formData();
      const file = form.get('video');
      const caption = String(form.get('caption')||'');
      const scheduledAt = String(form.get('scheduled_at')||'');
      if (!file || typeof file === 'string') return json({ok:false,error:'Video file required'},400);
      if (!scheduledAt) return json({ok:false,error:'Schedule time required'},400);
      if (!env.MEDIA_BUCKET) return json({ok:false,error:'Media storage is not configured'},503);
      const id = crypto.randomUUID();
      const key = `scheduled/${id}.mp4`;
      await env.MEDIA_BUCKET.put(key,file.stream(),{httpMetadata:{contentType:file.type||'video/mp4'}});
      const item = {id,key,caption,scheduledAt,status:'queued',createdAt:new Date().toISOString()};
      await env.QUEUE_KV.put(`schedule:${id}`,JSON.stringify(item));
      return json({ok:true,schedule_id:id,status:'queued'});
    }

    if (url.pathname === '/api/instagram/publish-now' && request.method === 'POST') {
      if (!env.IG_USER_ID || !env.IG_ACCESS_TOKEN) return json({ok:false,error:'Instagram not connected'},401);
      const body = await request.json();
      const videoUrl = body.video_url;
      const caption = body.caption || '';
      if (!videoUrl) return json({ok:false,error:'Public video_url required'},400);
      const create = await fetch(`https://graph.instagram.com/v23.0/${env.IG_USER_ID}/media`,{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({media_type:'REELS',video_url:videoUrl,caption,access_token:env.IG_ACCESS_TOKEN})
      });
      const c = await create.json();
      if (!create.ok || !c.id) return json({ok:false,error:c.error?.message||'Container creation failed',details:c},400);
      return json({ok:true,container_id:c.id,status:'processing'});
    }

    if (url.pathname === '/api/instagram/publish-container' && request.method === 'POST') {
      if (!env.IG_USER_ID || !env.IG_ACCESS_TOKEN) return json({ok:false,error:'Instagram not connected'},401);
      const body = await request.json();
      if (!body.creation_id) return json({ok:false,error:'creation_id required'},400);
      const pub = await fetch(`https://graph.instagram.com/v23.0/${env.IG_USER_ID}/media_publish`,{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({creation_id:body.creation_id,access_token:env.IG_ACCESS_TOKEN})
      });
      const p = await pub.json();
      if (!pub.ok || !p.id) return json({ok:false,error:p.error?.message||'Publish failed',details:p},400);
      return json({ok:true,media_id:p.id,status:'published'});
    }

    return json({name:'REACH AI Instagram backend',ok:true});
  },

  async scheduled(controller, env, ctx) {
    if (!env.QUEUE_KV) return;
    const list = await env.QUEUE_KV.list({prefix:'schedule:'});
    const now = Date.now();
    for (const k of list.keys) {
      const raw = await env.QUEUE_KV.get(k.name);
      if (!raw) continue;
      const item = JSON.parse(raw);
      if (item.status !== 'queued' || new Date(item.scheduledAt).getTime() > now) continue;
      // A production deployment should expose the stored R2 object through a public/custom domain,
      // create the Instagram REELS media container, poll container status until FINISHED, then call media_publish.
      item.status = 'ready_to_publish';
      item.checkedAt = new Date().toISOString();
      await env.QUEUE_KV.put(k.name,JSON.stringify(item));
    }
  }
};
