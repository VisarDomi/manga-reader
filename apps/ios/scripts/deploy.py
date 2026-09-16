#!/usr/bin/env python3
"""Deploy one provider app using the configured trusted Mac and signing team."""
import argparse, hashlib, json, pathlib, re, shlex, subprocess
ROOT = pathlib.Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(); parser.add_argument('command', choices=['sync','guest','build','status','check','install','launch','finish']); parser.add_argument('provider'); args = parser.parse_args()
subprocess.run(['node', str(ROOT.parent.parent/'scripts/build-ios.mjs'), args.provider, '--prepare-only'], check=True) if args.command == 'sync' else None
registry = json.loads((ROOT/'build/providers.json').read_text())
if args.provider not in registry: parser.error('Unsupported iOS provider: '+args.provider)
provider = registry[args.provider]
config = json.loads((ROOT / 'deploy.local.json').read_text())
suffix = config.get('bundleSuffix', '')
if suffix and not re.fullmatch(r'\.[A-Za-z0-9-]+', suffix): parser.error('Invalid bundleSuffix')
bundle_id = provider['bundleIdentifier'] + suffix
remote = '/Users/visar/Developer/asura-reader'
host = config['host']; uid = int(config['guiUid'])
ssh = ['ssh','-o','BatchMode=yes','-o','ConnectTimeout=8','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+config['knownHosts'],host]
def run(script): subprocess.run(ssh + [script], check=True)
q = shlex.quote
app = remote + '/build/'+args.provider+suffix+'/Release-iphoneos/'+provider['productName']+'.app'
if args.command == 'sync':
    build = ROOT / 'build'; build.mkdir(exist_ok=True)
    run('mkdir -p '+q(remote+'/build'))
    subprocess.run(['rsync','-az','--exclude=build','--exclude=.build','--exclude=.swiftpm','--exclude=deploy.local.json','-e',shlex.join(ssh[:-1]),str(ROOT)+'/',host+':'+remote+'/'],check=True)
    subprocess.run(['scp',*ssh[1:-1],str(build/'providers.json'),host+':'+remote+'/build/providers.json'],check=True)
elif args.command == 'guest': run('cd '+q(remote)+' && env -u DEVELOPMENT_TEAM /usr/bin/caffeinate -i /usr/bin/python3 scripts/build-guest.py '+q(args.provider))
elif args.command == 'build':
    # Enter the GUI signing session without registering a background item;
    # immediately drop root and keep SSH attached until the build exits.
    command = ['sudo','-n','launchctl','asuser',str(uid),'sudo','-n','-H','-u','#'+str(uid),'/usr/bin/env',
               'DEVELOPMENT_TEAM='+config['signingTeam'],'READER_BUNDLE_SUFFIX='+suffix,'DEVELOPMENT_DEVICE='+config['device'],
               '/usr/bin/caffeinate','-i','/bin/bash',remote+'/scripts/build.sh',args.provider]
    run('/bin/bash -o pipefail -c '+q(shlex.join(command)+' 2>&1 | tee '+q(remote+'/gui-build.log')))
elif args.command == 'status': run('tail -8 '+q(remote+'/gui-build.log'))
elif args.command == 'finish': print('Build runs attached; no background job to remove.')
elif args.command == 'launch': run('xcrun devicectl device process launch --device '+q(config['device'])+' '+q(bundle_id))
else:
    checks = ['set -eu','codesign --verify --deep --strict '+q(app)]
    for folder in ['Web','Native']:
        for file in sorted((ROOT/'Resources'/folder).glob('*')):
            if file.is_file() and not file.name.startswith('.'):
                digest=hashlib.sha256(file.read_bytes()).hexdigest()
                checks.append('test "$(shasum -a 256 '+q(app+'/'+folder+'/'+file.name)+' | cut -d " " -f 1)" = '+q(digest))
    checks.append('test "$(/usr/libexec/PlistBuddy -c "Print CFBundleIdentifier" '+q(app+'/Info.plist')+')" = '+q(bundle_id))
    if args.command == 'install': checks.append('xcrun devicectl device install app --device '+q(config['device'])+' '+q(app))
    run('\n'.join(checks))
