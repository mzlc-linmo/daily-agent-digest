import json, os, subprocess, sys, tempfile, unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]

def command(home, name, payload):
    p = subprocess.run([sys.executable, str(ROOT/'daily_agent_digest.py'), '--app-command', name], input=json.dumps(payload), text=True, capture_output=True, env={**os.environ, 'DIGEST_HOME': str(home), 'DIGEST_DEBUG': '1'}, check=False)
    assert p.returncode == 0, p.stderr + p.stdout
    return json.loads(p.stdout)

class CoreProtocolTests(unittest.TestCase):
    def test_clear_and_settings_are_private_and_atomic(self):
        with tempfile.TemporaryDirectory() as d:
            home = Path(d); state = command(home, 'clear', {'date':'2099-01-01'})
            self.assertEqual(state['report_status'], 'generating')
            command(home, 'save-settings', {'base_url':'https://example.invalid/v1', 'model':'test-model', 'api_key':'secret'})
            self.assertEqual((home/'.env').stat().st_mode & 0o777, 0o600)
            self.assertEqual(command(home, 'settings', {})['model'], 'test-model')
            self.assertFalse((home/'state.json.tmp').exists())

if __name__ == '__main__': unittest.main()
