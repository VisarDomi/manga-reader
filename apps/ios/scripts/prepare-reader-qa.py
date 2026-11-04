#!/usr/bin/env python3
"""Prepare an isolated simulator-only app from an exact committed product revision."""
import argparse
import io
import json
from pathlib import Path
import shutil
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[3]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--revision', required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()
revision = subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', args.revision + '^{commit}'], text=True).strip()
output = Path(args.output).resolve()
if output.exists(): raise SystemExit('Choose a fresh QA output directory')
output.mkdir(parents=True)
archive = subprocess.check_output(['git', '-C', str(ROOT), 'archive', revision, 'apps/ios'])
with tarfile.open(fileobj=io.BytesIO(archive)) as source:
    source.extractall(output, filter='data')
app = output / 'apps/ios'
tests = Path(__file__).resolve().parents[1] / 'Tests'
for name in ['CPUChecks.swift', 'WorkloadScenario.swift']:
    shutil.copy2(tests / name, app / 'MangaReader' / name)
(app / 'MangaReader/AppDelegate.swift').write_text('''#if targetEnvironment(simulator)
import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    static func scheduleRefresh() {}
    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "QA", sessionRole: session.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        window.overrideUserInterfaceStyle = .dark
        window.rootViewController = ProcessInfo.processInfo.arguments.contains("-cpu-check") ? CPUChecks() : ReaderChecks()
        window.makeKeyAndVisible()
        self.window = window
    }
}
#else
#error("The QA overlay must never build for a physical device")
#endif
''')
(output / 'qa-source.json').write_text(json.dumps({'revision': revision, 'simulatorOnly': True}, indent=2))
print(app)
