"""Exercise the installed BB provider and real Pi child; no BB thread or LLM call.
Leaves its isolated artifacts intact; only its owned process group is stopped.
"""
import argparse
import json
import os
import select
import signal
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--host-artifact', type=Path, required=True, help='Installed ordinary provider-pi host artifact')
parser.add_argument('--addon-artifact', type=Path, default=ROOT / 'dist/host.js')
args = parser.parse_args()
HOST = args.host_artifact.resolve()
ADDON = args.addon_artifact.resolve()
SCRATCH = Path(tempfile.mkdtemp(prefix='pi-command-sync-live-'))
driver = f'''
import {{experimental_providerBridge as bridge}} from {json.dumps(HOST.as_uri())};
import {{prepareRuntime}} from {json.dumps(ADDON.as_uri())};
process.env.BB_PI_BRIDGE_COMMAND = prepareRuntime({json.dumps(str(SCRATCH / 'data'))}).launcher;
bridge.start({{pluginId: 'provider-pi', dataDir: {json.dumps(str(SCRATCH))}, tempDir: {json.dumps(str(SCRATCH))}}});
let buffer = '';
process.stdin.on('data', chunk => {{
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf('\\n')) >= 0) {{
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    bridge.handleLine(line);
  }}
}});
'''
env = dict(os.environ, HOME=str(SCRATCH),
           PI_CODING_AGENT_DIR=os.environ.get('PI_CODING_AGENT_DIR', str(Path.home() / '.pi/agent')),
           BB_PI_BRIDGE_ARGS=json.dumps(['--extension', str(ROOT / 'tests/no-model-probe.mjs')]),
           BB_PI_BRIDGE_SESSION_DIR=str(SCRATCH / 'sessions'),
           BB_PI_COMMAND_MENU_DIR=str(SCRATCH / 'menu'))
process = subprocess.Popen(['node', '--input-type=module', '-e', driver], cwd=SCRATCH, env=env,
                           stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                           stderr=(SCRATCH / 'stderr.log').open('wb'), start_new_session=True)
assert process.stdin is not None and process.stdout is not None
stdin, stdout = process.stdin, process.stdout
buffer = b''
records = []
OPTIONS = {'permissionMode': 'full', 'permissionScope': 'full', 'approvalReviewer': None, 'permissionEscalation': None}


def send(method, params, req_id):
    stdin.write((json.dumps({'jsonrpc': '2.0', 'id': req_id, 'method': method, 'params': params}) + '\n').encode())
    stdin.flush()


def wait_for(predicate, timeout=65):
    global buffer
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        while b'\n' in buffer:
            line, buffer = buffer.split(b'\n', 1)
            record = json.loads(line)
            records.append(record)
            if record.get('method') == 'interaction/request':
                stdin.write((json.dumps({'jsonrpc': '2.0', 'id': record['id'], 'result': {'cancelled': True}}) + '\n').encode())
                stdin.flush()
            if predicate(record):
                return record
        if select.select([stdout], [], [], 0.2)[0]:
            chunk = os.read(stdout.fileno(), 65536)
            assert chunk, 'Provider exited; inspect isolated stderr.log'
            buffer += chunk
    raise AssertionError('Provider did not finish in time; inspect isolated stderr.log')


def request(method, params, req_id):
    send(method, params, req_id)
    response = wait_for(lambda record: record.get('id') == req_id and 'method' not in record)
    assert 'error' not in response, response
    return response['result']


try:
    request('initialize', {'protocolVersion': 2, 'client': {'name': 'slash-regression', 'version': '1'}}, 'init')
    result = request('thread/start', {'threadId': 'isolated-slash-probe', 'cwd': str(SCRATCH),
                                     'options': OPTIONS, 'instructionMode': 'append'}, 'start')
    provider_id = result['providerThreadId']
    for index, command in enumerate(['/session', '/commands reload', '/bb-probe', '/reload', '/thinking', '/settings']):
        start = len(records)
        req_id = f'command-{index}'
        mentions = []
        if command == '/reload':
            # Actual composer selection: command chip, not merely typed text.
            mentions = [{'start': 0, 'end': len(command), 'resource': {
                'kind': 'command', 'trigger': '/', 'name': 'reload', 'source': 'command',
                'origin': 'user', 'label': 'reload', 'argumentHint': None}}]
        send('turn/start', {'threadId': 'isolated-slash-probe', 'providerThreadId': provider_id,
                            'options': OPTIONS, 'clientRequestId': 'creq_' + '2' * 9 + str(index + 2),
                            'input': [{'type': 'text', 'text': command, 'mentions': mentions}]}, req_id)
        # The settled boundary can arrive before or after the acceptance reply.
        def complete(_record, start=start, req_id=req_id):
            page = records[start:]
            accepted = any(r.get('id') == req_id and 'result' in r for r in page)
            failed = [r['error'] for r in page if r.get('id') == req_id and 'error' in r]
            assert not failed, failed
            settled = any(d.get('kind') == 'turn.boundary' for r in page for d in r.get('params', {}).get('deltas', []))
            return accepted and settled
        wait_for(complete)
        page = json.dumps(records[start:])
        assert 'FELL THROUGH' not in page, command
        assert 'provider/stream' not in page, 'Unexpected model request'
        expected = {'/session': 'sessionId', '/commands reload': '/reload',
                    '/bb-probe': 'Command executed', '/reload': 'Reloaded Pi',
                    '/thinking': 'Thinking:', '/settings': 'BB cannot render'}[command]
        assert expected in page, f'{command} did not return its native result'
        assert 'agent_start' not in page, 'Unexpected model turn'
        print(f'PASS {command}: accepted, native result, settled boundary')
finally:
    (SCRATCH / 'records.jsonl').write_text(''.join(json.dumps(record) + '\n' for record in records))
    print(f'Artifacts retained: {SCRATCH}')
    # Do not invoke the production worker cleanup hooks or delete test files.
    os.killpg(process.pid, signal.SIGKILL)
    process.wait(timeout=10)
    stdin.close()
    stdout.close()
