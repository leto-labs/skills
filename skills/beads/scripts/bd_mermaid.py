#!/usr/bin/env python3
"""Render `bd list --json` output as a Mermaid flowchart.

Usage:
  bd list --all --json | python3 bd_mermaid.py [--label project:x] [--no-closed]

Edges point from a prerequisite to the issue it unblocks. Parent-child edges
are dotted. Edges to issues missing from the input are dropped.
"""
import argparse
import json
import sys

STATUS_CLASS = {
    "open": "open",
    "in_progress": "active",
    "blocked": "blocked",
    "closed": "closed",
    "deferred": "deferred",
}


def node_id(issue_id: str) -> str:
    return "n_" + "".join(c if c.isalnum() else "_" for c in issue_id)


def label(issue: dict) -> str:
    title = issue.get("title", "").replace('"', "'")
    if len(title) > 48:
        title = title[:45] + "..."
    return f'{issue["id"]}<br/>{title}'


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", action="append", default=[], help="keep issues with ALL these labels")
    ap.add_argument("--no-closed", action="store_true", help="drop closed issues")
    ap.add_argument("--direction", default="LR", choices=["LR", "TD"])
    args = ap.parse_args()

    issues = json.load(sys.stdin)
    if isinstance(issues, dict):
        issues = [issues]
    keep = {
        i["id"]: i
        for i in issues
        if all(l in (i.get("labels") or []) for l in args.label)
        and not (args.no_closed and i.get("status") == "closed")
    }

    out = [f"flowchart {args.direction}"]
    for i in keep.values():
        cls = STATUS_CLASS.get(i.get("status", ""), "open")
        out.append(f'  {node_id(i["id"])}["{label(i)}"]:::{cls}')
    for i in keep.values():
        for d in i.get("dependencies") or []:
            src, dst, kind = d.get("depends_on_id"), d.get("issue_id"), d.get("type", "blocks")
            if src not in keep or dst not in keep:
                continue
            arrow = "-.->" if kind == "parent-child" else "-->"
            text = "" if kind in ("blocks", "parent-child") else f"|{kind}|"
            out.append(f"  {node_id(src)} {arrow}{text} {node_id(dst)}")
    out += [
        "  classDef open fill:#fff,stroke:#888",
        "  classDef active fill:#dbeafe,stroke:#2563eb",
        "  classDef blocked fill:#fee2e2,stroke:#dc2626",
        "  classDef closed fill:#e5e7eb,stroke:#9ca3af,color:#6b7280",
        "  classDef deferred fill:#fef9c3,stroke:#ca8a04",
    ]
    print("\n".join(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
