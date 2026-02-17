#!/usr/bin/env python3
"""
Generate French-English dictionary from Wiktionary data (kaikki.org).

Downloads French entries extracted from English Wiktionary and processes
them into a compact JSON dictionary for the DualSubs extension.

Source: https://kaikki.org/dictionary/French/index.html
Data extracted from enwiktionary by wiktextract.
"""

import json
import os
import sys
import urllib.request

# French word entries from English Wiktionary (all senses, ~484 MB)
KAIKKI_URL = "https://kaikki.org/dictionary/French/kaikki.org-dictionary-French.jsonl"
RAW_FILE = "kaikki-french.jsonl"
OUTPUT_FILE = "fr-en.json"


def download_data():
    if os.path.exists(RAW_FILE):
        size_mb = os.path.getsize(RAW_FILE) / (1024 * 1024)
        print(f"Using cached {RAW_FILE} ({size_mb:.1f} MB)")
        return

    print("Downloading French Wiktionary data from kaikki.org...")
    print(f"URL: {KAIKKI_URL}")
    print("This is ~484 MB and may take a few minutes...")

    def progress(block_num, block_size, total_size):
        downloaded = block_num * block_size
        if total_size > 0:
            pct = min(100, downloaded * 100 / total_size)
            mb = downloaded / (1024 * 1024)
            total_mb = total_size / (1024 * 1024)
            sys.stdout.write(f"\r  {mb:.1f} / {total_mb:.1f} MB ({pct:.0f}%)")
        else:
            mb = downloaded / (1024 * 1024)
            sys.stdout.write(f"\r  {mb:.1f} MB downloaded")
        sys.stdout.flush()

    urllib.request.urlretrieve(KAIKKI_URL, RAW_FILE, progress)
    print()
    size_mb = os.path.getsize(RAW_FILE) / (1024 * 1024)
    print(f"Downloaded {size_mb:.1f} MB")


POS_MAP = {
    "noun": "n",
    "verb": "v",
    "adj": "adj",
    "adv": "adv",
    "prep": "prep",
    "conj": "conj",
    "pron": "pron",
    "det": "det",
    "intj": "intj",
    "num": "num",
    "particle": "part",
    "phrase": "phrase",
    "suffix": "suffix",
    "prefix": "prefix",
    "article": "art",
    "name": "name",
    "proverb": "phrase",
    "contraction": "contr",
}

# Lower number = higher priority (will replace existing entry)
POS_PRIORITY = {
    "det": 1, "pron": 2, "prep": 3, "conj": 4, "art": 5,
    "adj": 6, "n": 7, "v": 8, "adv": 9, "contr": 10,
    "intj": 11, "num": 12, "part": 13, "phrase": 14,
    "name": 50, "suffix": 50, "prefix": 50,
    "character": 50, "symbol": 50, "punct": 50,
}

MAX_DEFS = 4


def extract_definitions(senses):
    """Extract unique definitions from an entry's senses."""
    defs = []
    for sense in senses:
        glosses = sense.get("glosses", [])
        if not glosses:
            continue
        gloss = glosses[0]
        if gloss.startswith("Alternative") or gloss.startswith("Obsolete spelling"):
            if len(glosses) > 1:
                gloss = glosses[1]
            else:
                continue
        if gloss and gloss not in defs:
            defs.append(gloss)
    return defs


def process_data():
    dictionary = {}
    forms_map = {}  # inflected form -> (base_word, pos)
    skipped = 0

    print("Processing entries...")
    with open(RAW_FILE, "r", encoding="utf-8") as f:
        for line_num, line in enumerate(f, 1):
            if line_num % 10000 == 0:
                sys.stdout.write(
                    f"\r  {line_num} lines, {len(dictionary)} entries, "
                    f"{len(forms_map)} forms"
                )
                sys.stdout.flush()

            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue

            word = entry.get("word", "").strip()
            if not word:
                continue

            pos = entry.get("pos", "")
            senses = entry.get("senses", [])
            forms = entry.get("forms", [])

            if not senses:
                skipped += 1
                continue

            entry_defs = extract_definitions(senses)
            if not entry_defs:
                skipped += 1
                continue

            short_pos = POS_MAP.get(pos, pos)

            # Gender for nouns
            gender = None
            if pos == "noun":
                for ht in entry.get("head_templates", []):
                    args = ht.get("args", {})
                    for val in args.values():
                        if val in ("m", "f", "m-p", "f-p", "mf", "m or f"):
                            gender = val
                            break
                    if gender:
                        break

            lower = word.lower()

            if lower not in dictionary:
                data = {"pos": short_pos, "def": entry_defs[0]}
                if gender:
                    data["gender"] = gender
                if len(entry_defs) > 1:
                    data["defs"] = entry_defs[:MAX_DEFS]
                dictionary[lower] = data
            else:
                existing = dictionary[lower]
                existing_prio = POS_PRIORITY.get(existing["pos"], 30)
                new_prio = POS_PRIORITY.get(short_pos, 30)

                if new_prio < existing_prio:
                    # Better POS — replace entry, merge defs
                    old_defs = existing.get("defs", [existing["def"]])
                    data = {"pos": short_pos, "def": entry_defs[0]}
                    if gender:
                        data["gender"] = gender
                    merged = list(entry_defs)
                    for d in old_defs:
                        if d not in merged and len(merged) < MAX_DEFS:
                            merged.append(d)
                    if len(merged) > 1:
                        data["defs"] = merged
                    dictionary[lower] = data
                else:
                    # Keep existing but merge new definitions in
                    if "defs" not in existing:
                        existing["defs"] = [existing["def"]]
                    for d in entry_defs:
                        if d not in existing["defs"] and len(existing["defs"]) < MAX_DEFS:
                            existing["defs"].append(d)

            # Collect inflected forms
            for form_entry in forms:
                form = form_entry.get("form", "").strip()
                if not form or len(form) <= 1:
                    continue
                form_lower = form.lower()
                if form_lower != lower and form_lower not in forms_map:
                    forms_map[form_lower] = (lower, short_pos)

    print(
        f"\r  Done: {len(dictionary)} base entries, "
        f"{len(forms_map)} inflected forms, {skipped} skipped"
    )

    # Add inflected forms that aren't already base entries
    added = 0
    for form, (base, pos) in forms_map.items():
        if form not in dictionary and base in dictionary:
            dictionary[form] = {"pos": pos, "def": "", "base": base}
            added += 1

    print(f"  Added {added} inflected form entries")
    print(f"  Total: {len(dictionary)} entries")
    return dictionary


def truncate(s, maxlen=60):
    if len(s) > maxlen:
        return s[: maxlen - 3] + "..."
    return s


def filter_for_bundling(dictionary):
    """Filter dictionary for bundling with the extension.
    Keeps all useful entries, skips only obscure categories."""

    skip_pos = {"name", "suffix", "prefix"}
    filtered = {}
    for word, entry in dictionary.items():
        if entry["pos"] in skip_pos:
            continue
        if " " in word or len(word) > 30:
            continue

        compact = {"pos": entry["pos"], "def": truncate(entry["def"])}
        if "gender" in entry:
            compact["gender"] = entry["gender"]
        if "base" in entry:
            compact["base"] = entry["base"]
        if "defs" in entry and len(entry["defs"]) > 1:
            compact["defs"] = [truncate(d) for d in entry["defs"]]
        filtered[word] = compact

    return filtered


def write_dict(dictionary, filename):
    with open(filename, "w", encoding="utf-8") as f:
        json.dump(dictionary, f, ensure_ascii=False, separators=(",", ":"))
    size = os.path.getsize(filename)
    size_mb = size / (1024 * 1024)
    print(f"Written {len(dictionary)} entries to {filename}")
    if size_mb >= 1:
        print(f"File size: {size_mb:.1f} MB")
    else:
        print(f"File size: {size / 1024:.1f} KB")


def extract_phrases(dictionary):
    """Extract multi-word phrases (2-4 words) for phrase lookup."""
    skip_pos = {"name", "suffix", "prefix"}
    phrases = {}
    for word, entry in dictionary.items():
        parts = word.split()
        if len(parts) < 2 or len(parts) > 4:
            continue
        if len(word) > 30:
            continue
        if entry["pos"] in skip_pos:
            continue
        defn = entry["def"]
        if not defn:
            continue
        phrases[word] = {"pos": entry["pos"], "def": truncate(defn)}
    return phrases


def main():
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    download_data()
    full = process_data()

    # Write full dictionary (for optional download, not bundled)
    print("\nWriting full dictionary...")
    write_dict(full, "fr-en-full.json")

    # Write bundled dictionary (all useful entries, shorter definitions)
    print("\nFiltering for bundled version...")
    bundled = filter_for_bundling(full)
    write_dict(bundled, OUTPUT_FILE)

    # Write phrase dictionary
    print("\nExtracting phrases...")
    phrases = extract_phrases(full)
    write_dict(phrases, "fr-en-phrases.json")


if __name__ == "__main__":
    main()
