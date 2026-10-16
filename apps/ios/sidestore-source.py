"""Prints the SideStore (AltStore) source for one IPA: python3 sidestore-source.py <ipa>.

Reads VERSION, BUILD, BASE_URL (where the IPA and icon.png are served) and BUNDLE_PREFIX (as in
project.yml) from the environment.
"""

import json
import os
import sys
from datetime import datetime, timezone

ipa = sys.argv[1]
base = os.environ["BASE_URL"].rstrip("/")
version = os.environ["VERSION"]
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
            "tintColor": "E8820C",
            "apps": [
                {
                    "name": "Hatbot",
                    "bundleIdentifier": f"{prefix}.hatbot",
                    "developerName": "kubus",
                    "localizedDescription": about,
                    "iconURL": f"{base}/icon.png",
                    "tintColor": "E8820C",
                    "category": "utilities",
                    "versions": [
                        {
                            "version": version,
                            "buildVersion": os.environ["BUILD"],
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
                    # Sources must list what the app asks for, or SideStore refuses it.
                    "appPermissions": {
                        "entitlements": ["com.apple.security.application-groups"],
                        "privacy": {},
                    },
                }
            ],
            "news": [],
        },
        indent=2,
    )
)
