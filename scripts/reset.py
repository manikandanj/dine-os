"""Reset only a running DineOS service through its versioned command boundary."""
import argparse,json,uuid
from urllib.request import Request,urlopen
from urllib.parse import urlparse
from urllib.error import HTTPError,URLError
p=argparse.ArgumentParser();p.add_argument('--url',default='http://127.0.0.1:8001');a=p.parse_args()
if urlparse(a.url).hostname not in ('127.0.0.1','localhost','::1'):p.error('DineOS reset is restricted to loopback.')
try:
    with urlopen(a.url+'/api/health') as r:h=json.load(r)
    if h.get('product')!='DineOS':raise ValueError('Target is not DineOS. No reset was sent.')
    with urlopen(a.url+'/api/state') as r:s=json.load(r)
    c=dict(command_id='reset_'+uuid.uuid4().hex,epoch=s['epoch'],expected_state_version=s['state_version'],expected_ui_revision=s['ui_revision'],kind='reset',source='coordinator',payload={})
    request=Request(a.url+'/api/commands',data=json.dumps(c).encode(),headers={'Content-Type':'application/json'},method='POST')
    with urlopen(request) as r:fresh=json.load(r)
    print(f'DineOS reset to fresh service at state v{fresh["state_version"]}. Old pending offers and voice generations are invalid. Start/reconnect voice in the browser.')
except (HTTPError,URLError,ValueError) as e:p.exit(1,'Reset did not complete: '+str(e)+'\n')
