#!/usr/bin/env python3
"""Runs tools/config-cases.json against check_config.py (the same cases ShellConfigTest runs
against the app's parser).  python3 tools/test_check_config.py"""
import copy
import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("check_config", os.path.join(HERE, "check_config.py"))
cc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cc)


def main():
    with open(os.path.join(HERE, "config-cases.json"), encoding="utf-8") as f:
        data = json.load(f)
    failures = []
    for case in data["cases"]:
        c = copy.deepcopy(data["base"])
        c.update(case["config"])
        try:
            norm = cc.check_for_provisioning(c)
            ok = True
        except cc.Invalid as e:
            ok, norm = False, str(e)
        if ok != case["ok"]:
            failures.append("%s: expected %s, got %s (%s)" % (case["name"], case["ok"], ok, norm))
        elif ok and "haUrl" in case and norm != case["haUrl"]:
            failures.append("%s: haUrl %s, expected %s" % (case["name"], norm, case["haUrl"]))

    # Python-only: the app's parser may differ here, so the check is the stricter one.
    for name, text in [
        ("duplicate key", '{"haUrl":"ws://192.168.1.1:8123/api/websocket","haUrl":"x","token":"%s"}' % ("t" * 30)),
        ("NaN", '{"haUrl":"ws://192.168.1.1:8123/api/websocket","token":"%s","dim":NaN}' % ("t" * 30)),
        ("not an object", "[1, 2]"),
        ("not json", "nope"),
    ]:
        try:
            cc.check_for_provisioning(cc.loads(text))
            failures.append("%s: accepted" % name)
        except cc.Invalid:
            pass
    for name, extra in [(".local name", {"haUrl": "ws://homeassistant.local:8123/api/websocket"}),
                        ("placeholder token", {"token": "PASTE-A-LONG-LIVED-ACCESS-TOKEN"}),
                        ("short token", {"token": "abc"}),
                        ("no haUrl", {"haUrl": None})]:
        c = dict(data["base"], **extra)
        try:
            cc.check_for_provisioning(c)
            failures.append("%s: accepted" % name)
        except cc.Invalid as e:
            if "test-token" in str(e):
                failures.append("%s: message quotes the token" % name)

    total = len(data["cases"]) + 8
    if failures:
        print("\n".join(failures))
        print("%d of %d checks failed" % (len(failures), total))
        sys.exit(1)
    print("all %d config checks pass" % total)


if __name__ == "__main__":
    main()
