"""LC-specific renewal checks: helpers must carry the exact approved main profile."""
import pathlib
import plistlib
import tempfile
import unittest
from unittest.mock import patch
import refresh

BUNDLE = 'com.kdt.livecontainer.AVQL5DLWLT'

class MainProfileHelpers(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.app = pathlib.Path(self.directory.name) / 'LiveContainer.app'
        self.app.mkdir()
        (self.app / 'embedded.mobileprovision').write_bytes(b'new-host-profile')
        for name in ['LaunchAppExtension', 'ShareExtension']:
            helper = self.app / ('PlugIns/' + name + '.appex')
            helper.mkdir(parents=True)
            (helper / 'embedded.mobileprovision').write_bytes(b'new-host-profile')
            (helper / 'Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier': BUNDLE + '.' + name}))
        self.expected = ['AVQL5DLWLT.' + BUNDLE]

    def validate(self):
        with patch.object(refresh, 'profile', return_value={'id': self.expected[0], 'expires': 2000000000}) as read:
            result = refresh.app_profiles(self.app, self.expected)
            self.assertEqual(read.call_count, 1)
            return result

    def test_identical_helper_profiles_share_one_renewal_deadline(self):
        self.assertEqual(set(self.validate()), set(self.expected))

    def test_stale_helper_profile_is_rejected(self):
        (self.app / 'PlugIns/ShareExtension.appex/embedded.mobileprovision').write_bytes(b'old-profile')
        with self.assertRaisesRegex(RuntimeError, 'exact main profile'):
            self.validate()

    def test_missing_helper_profile_is_rejected(self):
        (self.app / 'PlugIns/ShareExtension.appex/embedded.mobileprovision').unlink()
        with self.assertRaisesRegex(RuntimeError, 'helper profile set'):
            self.validate()

    def test_unexpected_helper_is_rejected(self):
        extra = self.app / 'PlugIns/Unexpected.appex'
        extra.mkdir()
        (extra / 'embedded.mobileprovision').write_bytes(b'new-host-profile')
        with self.assertRaisesRegex(RuntimeError, 'helper profile set'):
            self.validate()

    def test_wrong_helper_bundle_id_is_rejected(self):
        (self.app / 'PlugIns/ShareExtension.appex/Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier': 'wrong'}))
        with self.assertRaisesRegex(RuntimeError, 'approved bundle ID'):
            self.validate()

unittest.main()
