#!/usr/bin/env python3
"""Deploy one provider app (providers.json) using the configured trusted Mac and signing team."""
import argparse, hashlib, json, pathlib, re, shlex, subprocess
ROOT = pathlib.Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(); parser.add_argument('command', choices=['sync','build','status','check','install','launch','finish']); parser.add_argument('provider'); args = parser.parse_args()
registry = json.loads((ROOT/'providers.json').read_text())
if args.provider not in registry: parser.error('Unsupported iOS provider: '+args.provider)
provider = registry[args.provider]
config = json.loads((ROOT / 'deploy.local.json').read_text())
suffix = config.get('bundleSuffix', '')
if suffix and not re.fullmatch(r'\.[A-Za-z0-9-]+', suffix): parser.error('Invalid bundleSuffix')
bundle_id = provider['bundleIdentifier'] + suffix
remote = '/Users/visar/Developer/manga-reader/apps/ios'
host = config['host']; uid = int(config['guiUid'])
ssh = ['ssh','-o','BatchMode=yes','-o','ConnectTimeout=8','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+config['knownHosts'],host]
def run(script): subprocess.run(ssh + [script], check=True)
q = shlex.quote
app = remote + '/build/'+args.provider+suffix+'/Release-iphoneos/'+provider['productName']+'.app'
# Approves the installed build as its renewal baseline only if it is exactly what was built (ios-tools renewal).
deliver = shlex.join(['/usr/bin/python3','/Users/visar/Developer/ios-tools/renewal/scripts/deliver.py']) + ' {} --repo manga-reader --app '+q(args.provider)+' --bundle '+q(bundle_id)
if args.command == 'sync':
    # --delete keeps the Mac's sources an exact copy; build output and local settings stay.
    run('mkdir -p '+q(remote+'/build'))
    subprocess.run(['rsync','-az','--delete','--exclude=build/','--exclude=.build/','--exclude=.swiftpm/','--exclude=__pycache__/','--exclude=deploy.local.json',
                    '-e',shlex.join(ssh[:-1]),str(ROOT)+'/',host+':'+remote+'/'],check=True)
elif args.command == 'build':
    # Enter the GUI signing session without registering a background item;
    # immediately drop root and keep SSH attached until the build exits.
    command = ['sudo','-n','launchctl','asuser',str(uid),'sudo','-n','-H','-u','#'+str(uid),'/usr/bin/env',
               'DEVELOPMENT_TEAM='+config['signingTeam'],'READER_BUNDLE_SUFFIX='+suffix,'DEVELOPMENT_DEVICE='+config['device'],
               '/usr/bin/caffeinate','-i','/bin/bash',remote+'/scripts/build.sh',args.provider]
    run(deliver.format('begin'))
    run('/bin/bash -o pipefail -c '+q(shlex.join(command)+' 2>&1 | tee '+q(remote+'/gui-build.log')))
    run(deliver.format('built'))
elif args.command == 'status': run('tail -8 '+q(remote+'/gui-build.log'))
elif args.command == 'finish': print('Build runs attached; no background job to remove.')
elif args.command == 'launch': run('xcrun devicectl device process launch --device '+q(config['device'])+' '+q(bundle_id))
else:
    checks = ['set -eu','codesign --verify --deep --strict '+q(app)]
    for file in sorted((ROOT/'Resources'/'Native').glob('*')):
        if file.is_file() and not file.name.startswith('.'):
            digest=hashlib.sha256(file.read_bytes()).hexdigest()
            checks.append('test "$(shasum -a 256 '+q(app+'/Native/'+file.name)+' | cut -d " " -f 1)" = '+q(digest))
    checks.append('test "$(/usr/libexec/PlistBuddy -c "Print CFBundleIdentifier" '+q(app+'/Info.plist')+')" = '+q(bundle_id))
    if args.command == 'install': checks += ['xcrun devicectl device install app --device '+q(config['device'])+' '+q(app), deliver.format('installed')]
    run('\n'.join(checks))
