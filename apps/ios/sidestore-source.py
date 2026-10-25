"""Prints the SideStore (AltStore) source for one IPA: python3 sidestore-source.py <ipa>.

The version, the build and the privacy strings the app asks for (NS...UsageDescription) come from the
IPA's own Info.plist files, so the source always says what the IPA is: SideStore refuses an app whose
version or permissions don't match its source. Reads BASE_URL (where the IPA and icon.png are served)
and BUNDLE_PREFIX (as in project.yml) from the environment.
"""

import json
import os
import plistlib
import re
import sys
import zipfile
from datetime import datetime, timezone

# The app's Info.plist, and its extensions'.
INFO = re.compile(r"^Payload/[^/]+\.app/(PlugIns/[^/]+\.appex/)?Info\.plist$")


def infos(ipa):
    """The app's Info.plist first, then its extensions'."""
    with zipfile.ZipFile(ipa) as z:
        names = sorted((n for n in z.namelist() if INFO.match(n)), key=lambda n: "/PlugIns/" in n)
        if not names or "/PlugIns/" in names[0]:
            sys.exit(f"{ipa}: no app Info.plist in Payload/")
        return [plistlib.loads(z.read(n)) for n in names]


def privacy(plists):
    """Every usage string the app or an extension asks with, as the source lists them."""
    out = {}
    for info in plists:
        for key, value in info.items():
            if key.startswith("NS") and key.endswith("UsageDescription"):
                out.setdefault(key, value)
    return dict(sorted(out.items()))


ipa = sys.argv[1]
plists = infos(ipa)
app = plists[0]
version = app["CFBundleShortVersionString"]
build = app["CFBundleVersion"]
base = os.environ["BASE_URL"].rstrip("/")
url = f"{base}/{os.path.basename(ipa)}"
size = os.path.getsize(ipa)
date = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
about = "Your self-hosted Hatbot: chat, tasks, approvals and the live desktop."
prefix = os.environ.get("BUNDLE_PREFIX") or "com.example"

print(
    json.dumps(
        {
            "name": "Hatbot",
            "identifier": f"{prefix}.hatbot.source",
            "sourceURL": f"{base}/source.json",
            "iconURL": f"{base}/icon.png",
            "tintColor": "507D12",
            "apps": [
                {
                    "name": "Hatbot",
                    "bundleIdentifier": f"{prefix}.hatbot",
                    "developerName": "kubus",
                    "localizedDescription": about,
                    "iconURL": f"{base}/icon.png",
                    "tintColor": "507D12",
                    "category": "utilities",
                    "versions": [
                        {
                            "version": version,
                            "buildVersion": build,
                            "date": date,
                            "downloadURL": url,
                            "size": size,
                            "minOSVersion": "18.0",
                        }
                    ],
                    # The same, for SideStore releases that read source v1.
                    "version": version,
                    "versionDate": date,
                    "downloadURL": url,
                    "size": size,
                    # Sources must list what the app asks for, or SideStore refuses it. The App Group is
                    # in project.yml's entitlements; the usage strings come from the IPA.
                    "appPermissions": {
                        "entitlements": ["com.apple.security.application-groups"],
                        "privacy": privacy(plists),
                    },
                }
            ],
            "news": [],
        },
        indent=2,
    )
)
