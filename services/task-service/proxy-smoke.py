import os, pathlib, subprocess, tempfile, time, uuid, json, hmac, hashlib
root=pathlib.Path(__file__).resolve().parents[2]; node=subprocess.check_output(['which','node'],text=True).strip()
proxy_image=os.environ.get('TASK_PROXY_IMAGE', 'dnmp-nginx:latest')
def run(args, **kwargs): return subprocess.run(args,check=True,text=True,capture_output=True,timeout=30,**kwargs).stdout.strip()
n='aiwb-proxy-'+uuid.uuid4().hex[:10]; srv=n+'-service'; proxy=n+'-nginx'
with tempfile.TemporaryDirectory(prefix='aiwb-proxy-') as d:
 p=pathlib.Path(d); shared=p/'run'; shared.mkdir(mode=0o777); shared.chmod(0o777); cert=p/'cert';cert.mkdir()
 subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(cert/'tls.key'),'-out',str(cert/'tls.crt'),'-days','1','-subj','/CN=localhost'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30)
 (cert/'tls.key').chmod(0o644); (cert/'tls.crt').chmod(0o644)
 nginx='''pid /tmp/nginx.pid; error_log stderr; events {} http { access_log off; client_body_temp_path /tmp/client_temp; proxy_temp_path /tmp/proxy_temp; fastcgi_temp_path /tmp/fastcgi_temp; uwsgi_temp_path /tmp/uwsgi_temp; scgi_temp_path /tmp/scgi_temp; include /tmp/site.conf; }'''
 (p/'nginx.conf').write_text(nginx)
 body=json.dumps({'action':'opened','sender':{'id':42},'repository':{'id':99},'issue':{'id':123,'title':'代理测试'}},separators=(',',':'))
 (p/'event.json').write_text(body); (p/'large.txt').write_text('x'*17000)
 sig='sha256='+hmac.new(b'test-secret',body.encode(),hashlib.sha256).hexdigest()
 try:
  run(['docker','run','-d','--rm','--name',srv,'--pull','never','--network','none','--user','65534:65534','--mount',f'type=bind,source={root},target=/work,readonly','--mount',f'type=bind,source={node},target=/usr/local/bin/node,readonly','--mount',f'type=bind,source={shared},target=/run/ai-workbench','-e','TASK_DB=/run/ai-workbench/tasks.db','-e','TASK_SOCKET=/run/ai-workbench/service.sock','-e','TASK_API_TOKEN='+('a'*64),'-e','GITHUB_WEBHOOK_SECRET=test-secret','-e','GITHUB_ALLOWED_SENDERS=42','-e','GITHUB_ALLOWED_REPOSITORIES=99','--workdir','/work','--entrypoint','/usr/local/bin/node','python:3.11-slim-bookworm','services/task-service/server.ts'])
  for _ in range(100):
   if (shared/'service.sock').exists(): break
   time.sleep(.1)
  else: raise RuntimeError('service socket unavailable')
  run(['docker','run','-d','--rm','--name',proxy,'--pull','never','--network','container:'+srv,'--user','65534:65534','--tmpfs','/tmp:rw,nosuid,size=16m','--mount',f'type=bind,source={shared},target=/run/ai-workbench','--mount',f'type=bind,source={cert},target=/etc/ai-workbench,readonly','--mount',f'type=bind,source={p}/nginx.conf,target=/tmp/nginx.conf,readonly','--mount',f'type=bind,source={root}/docs/nginx-webhooks.conf,target=/tmp/site.conf,readonly','--mount',f'type=bind,source={p}/event.json,target=/tmp/event.json,readonly','--mount',f'type=bind,source={p}/large.txt,target=/tmp/large.txt,readonly','--entrypoint','nginx',proxy_image,'-c','/tmp/nginx.conf','-g','daemon off;'])
  def curl(*args): return run(['docker','exec',proxy,'curl','-k','-sS','-o','/dev/null','-w','%{http_code}',*args])
  for _ in range(50):
   try:
    if curl('https://127.0.0.1:8443/tasks')=='404': break
   except subprocess.CalledProcessError: pass
   time.sleep(.1)
  else: raise RuntimeError('proxy unavailable')
  assert curl('https://127.0.0.1:8443/executions')=='404'
  assert curl('-X','POST','--data','{}','https://127.0.0.1:8443/webhooks/feishu')=='503'
  args=['-X','POST','-H','X-GitHub-Event: issues','-H','X-GitHub-Delivery: test','-H','X-Hub-Signature-256: '+sig,'--data-binary','@/tmp/event.json','https://127.0.0.1:8443/webhooks/github']
  def deliver(): return json.loads(run(['docker','exec',proxy,'curl','-k','-sS',*args]))
  assert deliver()['outcome']=='accepted'
  assert deliver()['outcome']=='duplicate'
  assert curl('-X','POST','-H','X-GitHub-Event: issues','-H','X-GitHub-Delivery: test','-H','X-Hub-Signature-256: wrong','--data-binary','@/tmp/event.json','https://127.0.0.1:8443/webhooks/github')=='403'
  assert curl('-X','POST','--data-binary','@/tmp/large.txt','https://127.0.0.1:8443/webhooks/github')=='413'
  print('容器内 TLS 代理：签名 GitHub 事件通过，管理接口拒绝，大请求拒绝')
 finally:
  for name in [proxy,srv]: subprocess.run(['docker','rm','-f',name],capture_output=True,timeout=15)
