"""Run only this checkout's loopback services; never stop unrelated listeners."""
import argparse,os,shutil,signal,socket,subprocess,sys,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser(description='Start DineOS locally')
p.add_argument('--backend-port',type=int,default=8001);p.add_argument('--frontend-port',type=int,default=5174);p.add_argument('--database')
a=p.parse_args()
if a.backend_port==a.frontend_port:p.error('Choose two separate ports.')
for port in (a.backend_port,a.frontend_port):
    if not 1024<=port<=65535:p.error('Use ports from 1024 through 65535.')
    with socket.socket() as s:
        try:s.bind(('127.0.0.1',port))
        except OSError:sys.exit(f'Port {port} is occupied. Existing services were left alone. Open the running app or select separate --backend-port / --frontend-port values.')
node=shutil.which('node')
if not node:sys.exit('Node.js 22.12+ is required. See README setup.')
if not (ROOT/'node_modules/vite/bin/vite.js').exists():sys.exit('Run pnpm install first.')
env={**os.environ,'DINEOS_ALLOWED_ORIGIN':f'http://127.0.0.1:{a.frontend_port}','DINEOS_API_PROXY':f'http://127.0.0.1:{a.backend_port}','DINEOS_RESET_ON_START':'1'}
if a.database:env['DINEOS_SQLITE_PATH']=str(Path(a.database).resolve())
processes=[]
def stop(*_):
    for proc in processes:
        if proc.poll() is None:proc.terminate()
    for proc in processes:
        try:proc.wait(timeout=5)
        except subprocess.TimeoutExpired:proc.kill()
signal.signal(signal.SIGTERM,lambda *_:sys.exit(0));signal.signal(signal.SIGINT,lambda *_:sys.exit(0))
try:
    processes.append(subprocess.Popen([sys.executable,'-m','uvicorn','backend.app.main:app','--host','127.0.0.1','--port',str(a.backend_port),'--no-access-log'],cwd=ROOT,env=env))
    processes.append(subprocess.Popen([node,'node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',str(a.frontend_port)],cwd=ROOT,env=env))
    print(f'\nDineOS: http://127.0.0.1:{a.frontend_port}/\nSynthetic kitchen; real model calls. Ctrl+C stops only these two services.\n',flush=True)
    while all(proc.poll() is None for proc in processes):time.sleep(.5)
    sys.exit(next((proc.returncode for proc in processes if proc.returncode),1))
finally:stop()
