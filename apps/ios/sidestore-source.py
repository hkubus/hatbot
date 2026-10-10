"""Prints the SideStore (AltStore) source for one IPA: python3 sidestore-source.py <ipa>.

Reads VERSION, BUILD and BASE_URL (where the IPA and icon.png are served) from the environment.
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

print(
    json.dumps(
        {
            "name": "Hatbot",
            "identifier": "ovh.gaycats.hatbot.source",
            "sourceURL": f"{base}/source.json",
            "iconURL": f"{base}/icon.png",
            "tintColor": "E8820C",
            "apps": [
                {
                    "name": "Hatbot",
                    "bundleIdentifier": "ovh.gaycats.hatbot",
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
                    "appPermissions": {"entitlements": [], "privacy": {}},
                }
            ],
            "news": [],
        },
        indent=2,
    )
)
