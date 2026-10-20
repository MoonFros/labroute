#!/usr/bin/env python3
"""
Convert MoonFros/ela-reports (.docx lab reports) into Labroute's JSON report
format + images, following the same schema produced by updaterepo.js.

Usage:
    python3 tools/convert_ela_reports.py [--limit N] [--apply]

By default runs in DRY-RUN mode (prints a summary, writes nothing).
Pass --apply to actually write files into labroute.

Notes
-----
* ela-reports .docx files are Word documents. Text is extracted section by
  section (Theory, Apparatus, Results, Analysis, Observations/Precautions,
  Graphs, Discussion). Embedded images are pulled out of the .docx media
  folder and saved to assets/lab_images/.
* Internal figure/section/table cross-references (e.g. "Figure 4.4",
  "see section 4.4") are STRIPPED from body text so they don't look out of
  place in labroute, which numbers its own sections (1. Aim ... 8. Learnings).
  Figure CAPTIONS are preserved and attached to their images.
* Hashtags are generated from department + course code + topic keywords.
"""

import argparse
import hashlib
import json
import os
import re
import zipfile

from docx import Document
from docx.oxml.ns import qn

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
ELA_DIR = '/tmp/ela-reports'
LABROUTE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
REPORTS_DIR = os.path.join(LABROUTE, 'content', 'reports')
IMAGES_DIR = os.path.join(LABROUTE, 'assets', 'lab_images')
INDEX_PATH = os.path.join(REPORTS_DIR, 'index.json')

SESSION = '2025/2026'
VERIFIED = True


# ---------------------------------------------------------------------------
# Department / code / level helpers
# ---------------------------------------------------------------------------
def dept_from_name(fname):
    upper = fname.upper()
    if upper.startswith('EXPERIMENT_2') or upper.startswith('EXPERIMENT_EE') \
            or 'EEE' in upper or 'EE2' in upper:
        return 'electrical'
    return 'mechanical'


def level_from_name(fname):
    upper = fname.upper()
    if re.search(r'EXPERIMENT[_\s]+2\d{2}', upper):
        return '200'
    return '300'


def clean_suffix(name):
    """Remove trailing (1), (3), v2 (1), _v2 etc. from a filename stem."""
    name = re.sub(r'\s*_v2\s*$', '', name, flags=re.I)
    name = re.sub(r'\s*\(\d+\)\s*$', '', name)
    return name


def code_from_name(fname):
    stem = clean_suffix(os.path.splitext(fname)[0])
    # ELA301_FM312_Impact_of_a_Jet -> after ELA301_, code token = FM312
    m = re.search(r'ELA3(?:0[12])_([A-Z]{2,4}\d{2,3}[A-Z]?)', stem, re.I)
    if m:
        token = m.group(1)
        code = re.sub(r'([A-Z]{2,4})(\d{2,3}[A-Z]?)', r'\1 \2', token)
        return code.upper()
    # Experiment_EEE212 -> EEE 212 ; Experiment_207 -> EE 207
    m = re.search(r'Experiment[_\s]+(EE|EEE)\s*(\d{2,3})', stem, re.I)
    if m:
        return f"{m.group(1).upper()} {m.group(2).upper()}"
    m = re.search(r'Experiment[_\s]+(\d{2,3}[A-Z]?)', stem, re.I)
    if m:
        return f"EE {m.group(1).upper()}"
    # Direct code like AM312, FM312, TD311a
    m = re.search(r'([A-Z]{2,4})\s*(\d{2,3}[A-Z]?)', stem, re.I)
    if m:
        return f"{m.group(1).upper()} {m.group(2).upper()}"
    # Fallback: leading letters + any digits (e.g. HT_Linear... -> HT)
    m = re.match(r'([A-Z]{2,4})', stem)
    if m:
        prefix = m.group(1).upper()
        d = re.search(r'(\d{2,3})', stem)
        return f"{prefix} {d.group(1)}" if d else prefix
    return stem.replace('_', ' ').title()


GENERIC_TITLES = {
    'laboratory reports', 'title', 'aim', 'objectives', 'apparatus',
    'theory', 'results', 'discussion', 'conclusion', 'experiment',
    'laboratory experiment', 'lab report',
}


def extract_title(doc, fname):
    paras = [p.text.strip() for p in doc.paragraphs if p.text.strip()]
    for p in paras[:10]:
        pl = p.lower()
        if pl.startswith(('name:', 'matric', 'group:', 'date:')):
            continue
        if 'laboratory' in pl and 'ela' in pl:
            continue
        if pl in GENERIC_TITLES:
            continue
        if pl.startswith('department of') and 'engineering' in pl:
            continue
        if pl.startswith('university of'):
            continue
        if pl.startswith('laboratory experiment'):
            continue
        if pl.startswith('experiment'):
            continue
        if re.match(r'^experiment\s+\d', pl):
            continue
        if re.match(r'^[a-z]{2,4}\s*\d{2,3}[a-z]?\s*$', pl):
            continue
        # Strip a leading parenthetical like "(no. not shown): " or "TD (no. not shown): "
        p2 = re.sub(r'^(?:[a-z]{1,4}\s*:?\s*)?\([^)]*\)\s*[:–]\s*', '', p, flags=re.I)
        # Strip a leading code prefix like "FM 312:" or "AM322: "
        p2 = re.sub(r'^([a-z]{2,4}\s*\d{2,3}[a-z]?)\s*[:–]\s*', '', p2, flags=re.I)
        # Strip a leading "TITLE" label
        p2 = re.sub(r'^title\s*[:–]\s*', '', p2, flags=re.I).strip()
        if p2:
            return p2
    stem = clean_suffix(os.path.splitext(fname)[0])
    return stem.replace('_', ' ').title()


SECTION_MAP = {
    'theory': 'theory',
    'apparatus': 'apparatus',
    'results': 'results',
    'analysis of results': 'analysis',
    'observations / precautions taken': 'precautions',
    'observations': 'precautions',
    'precautions': 'precautions',
    'graphs': 'graphs',
    'discussion': 'discussion',
    'conclusion': 'conclusion',
    'aim': 'aim',
    'objective': 'objectives',
    'objectives': 'objectives',
}


def classify_section(heading):
    h = heading.strip().lower()
    h = re.sub(r'^\d+\.\s*', '', h)
    for key, val in SECTION_MAP.items():
        if key in h:
            return val
    return 'other'


def extract_sections(doc):
    sections = {}
    current = 'preamble'
    sections[current] = []
    for p in doc.paragraphs:
        if not p.text.strip():
            continue
        style = p.style.name if p.style else ''
        if style == 'Heading 1':
            current = classify_section(p.text)
            sections.setdefault(current, [])
            continue
        sections.setdefault(current, []).append(p.text)
    return sections


# ---------------------------------------------------------------------------
# Figure cross-reference stripping (user's request)
# ---------------------------------------------------------------------------
XREF_PATTERNS = [
    r'\bsee\s+figure\s+\d+[.:]?\d*\b',
    r'\brefer\s+to\s+figure\s+\d+[.:]?\d*\b',
    r'\bas\s+shown\s+in\s+figure\s+\d+[.:]?\d*\b',
    r'\bfigure\s+\d+[.:]?\d*\b',
    r'\bfig\.\s*\d+[.:]?\d*\b',
    r'\bsection\s+\d+[.:]?\d*\b',
    r'\btable\s+\d+[.:]?\d*\b',
]


def strip_xrefs(text):
    for pat in XREF_PATTERNS:
        text = re.sub(pat, '', text, flags=re.I)
    text = re.sub(r'\s+', ' ', text).strip()
    return text


# ---------------------------------------------------------------------------
# Image extraction
# ---------------------------------------------------------------------------
def extract_images(fname):
    """
    Extract embedded images from the .docx in document order.
    Returns list of {data, ext, index}.
    """
    docx_path = os.path.join(ELA_DIR, fname)
    images = []
    embed_to_media = {}
    media_bytes = {}

    try:
        with zipfile.ZipFile(docx_path) as z:
            try:
                rels = z.read('word/_rels/document.xml.rels').decode('utf-8')
            except KeyError:
                rels = ''
            for m in re.finditer(r'Id="(rId\d+)"[^>]*Target="media/([^"]+)"', rels):
                embed_to_media[m.group(1)] = m.group(2)
            for n in z.namelist():
                if re.match(r'word/media/.+\.(png|jpg|jpeg|gif|bmp)$', n, re.I):
                    media_bytes[os.path.basename(n)] = z.read(n)
    except Exception as e:
        print(f"      [warn] could not read media for {fname}: {e}")
        return images

    doc = Document(docx_path)
    img_idx = 0
    for shape in doc.inline_shapes:
        xml = shape._inline.xml
        m = re.search(r'r:embed="(rId\d+)"', xml)
        if not m:
            continue
        embed = m.group(1)
        media_name = embed_to_media.get(embed)
        if not media_name or media_name not in media_bytes:
            continue
        ext = os.path.splitext(media_name)[1].lower()
        if ext not in ('.png', '.jpg', '.jpeg', '.gif', '.bmp'):
            continue
        img_idx += 1
        images.append({
            'data': media_bytes[media_name],
            'ext': '.jpg' if ext == '.jpg' else ext,
            'index': img_idx,
        })
    return images


FIG_CAPTION_RE = re.compile(r'^Figure\s+\d+[.:]?\s*(.+)$', re.I)

def find_captions(sections):
    captions = []
    for sec, paras in sections.items():
        for p in paras:
            m = FIG_CAPTION_RE.match(p.strip())
            if m:
                captions.append(m.group(1).strip())
    return captions


# ---------------------------------------------------------------------------
# Table extraction
# ---------------------------------------------------------------------------
def extract_tables(doc):
    tables = []
    for t in doc.tables:
        headers = [c.text.strip() for c in t.rows[0].cells]
        rows = []
        for r in t.rows[1:]:
            rows.append([c.text.strip() for c in r.cells])
        tables.append({'headers': headers, 'rows': rows})
    return tables


# ---------------------------------------------------------------------------
# Hashtag generation
# ---------------------------------------------------------------------------
TOPIC_KEYWORDS = {
    'friction': '#Friction', 'gear': '#Gears', 'gyroscope': '#Gyroscope',
    'governor': '#Governor', 'torsion': '#Torsion', 'rotor': '#RotorBalancing',
    'crank': '#CrankMechanism', 'quick return': '#QuickReturn', 'clutch': '#Clutch',
    'geneva': '#GenevaWheel', 'spring': '#Springs', 'flywheel': '#Flywheel',
    'dynamometer': '#Dynamometer', 'beam': '#BeamDeflection', 'cantilever': '#Cantilever',
    'strut': '#Strut', 'boiler': '#Boiler', 'jet': '#JetImpact', 'fluid': '#FluidMechanics',
    'vortex': '#VortexFlow', 'pipe flow': '#PipeFlow', 'weir': '#Weir', 'bernoulli': '#Bernoulli',
    'channel': '#ChannelFlow', 'shear centre': '#ShearCentre', 'bending': '#Bending',
    'tensile': '#TensileTest', 'conduction': '#HeatConduction', 'conductivity': '#Conductivity',
    'capacitance': '#Capacitance', 'inductance': '#Inductance', 'superposition': '#Superposition',
    'thevenin': '#Thevenin', 'oscilloscope': '#Oscilloscope', 'transformer': '#Transformer',
    'dc generator': '#DCGenerator', 'dc motor': '#DCMotor', 'three-phase': '#ThreePhase',
    'resistance': '#Resistance', 'fan regulator': '#FanRegulator', 'square wave': '#SquareWave',
    'phasor': '#PhasorDiagrams', 'power transfer': '#PowerTransfer', 'impact': '#ImpactTest',
    'floating body': '#Buoyancy', 'hydrostatic': '#Hydrostatic', 'mechanism': '#Mechanism',
    'kinematic': '#Kinematics',
}


def generate_hashtags(code, title, department):
    tags = set()
    tags.add('#MechanicalEngineering' if department == 'mechanical' else '#ElectricalEngineering')
    tags.add('#' + code.replace(' ', '').upper())
    text = (code + ' ' + title).lower()
    for kw, tag in TOPIC_KEYWORDS.items():
        if kw in text:
            tags.add(tag)
    return sorted(tags)


# ---------------------------------------------------------------------------
# ID helper
# ---------------------------------------------------------------------------
def make_id(code, title, part=None):
    base = (code + '-' + title).lower()
    base = re.sub(r'[^a-z0-9]+', '-', base)
    base = re.sub(r'(^-|-$)', '', base)
    if part:
        base = base + '-part-' + str(part)
    return base or 'report'


# ---------------------------------------------------------------------------
# Main conversion
# ---------------------------------------------------------------------------
PART_RE = re.compile(r'^\s*part\s+(\d+)\b', re.I)


def detect_part(sections):
    for p in sections.get('preamble', []):
        m = PART_RE.match(p.strip())
        if m:
            return int(m.group(1))
    return None


def convert_file(fname):
    docx_path = os.path.join(ELA_DIR, fname)
    doc = Document(docx_path)
    sections = extract_sections(doc)

    department = dept_from_name(fname)
    level = level_from_name(fname)
    code = code_from_name(fname)
    title = extract_title(doc, fname)
    part = detect_part(sections)
    rid = make_id(code, title, part=part)
    if part:
        title = f"{title} - Part {part}" 

    aim = ''
    objectives = []
    apparatus = []
    theory_paras = []
    procedure = []
    precautions = []
    discussion = ''
    conclusion = ''
    learnings = []

    preamble = sections.get('preamble', [])
    for p in preamble:
        pl = p.lower()
        body = re.sub(r'^(aim|objective[s]?)\s*[:–]\s*', '', p, flags=re.I).strip()
        if body and body != p:
            if pl.startswith('aim'):
                aim = body
            else:
                objectives.append(body)
        elif 'objectives:' in pl:
            body = re.sub(r'^objectives?\s*[:–]\s*', '', p, flags=re.I).strip()
            for part in re.split(r'\(\d+\)', body):
                part = part.strip()
                if part:
                    objectives.append(part)

    for p in sections.get('apparatus', []):
        pp = strip_xrefs(p)
        if not pp:
            continue
        if pp.startswith('[') and 'sketch' in pp.lower():
            continue
        apparatus.append(pp)

    for p in sections.get('theory', []):
        pp = strip_xrefs(p)
        if pp:
            theory_paras.append(pp)
    theory_text = '\n\n'.join(theory_paras)

    for sec in ('results', 'analysis'):
        for p in sections.get(sec, []):
            pp = strip_xrefs(p).strip()
            if not pp:
                continue
            if re.match(r'^\(?\d+\)?[\.\)]\s', pp) or pp.startswith(('•', '-', '–')):
                pp = re.sub(r'^\(?\d+\)?[\.\)]\s*', '', pp)
                pp = re.sub(r'^[•\–]\s*', '', pp)
                if pp:
                    procedure.append(pp)

    for p in sections.get('precautions', []):
        pp = strip_xrefs(p).strip()
        if pp:
            precautions_local = pp
            precautions.append(precautions_local)

    for p in sections.get('discussion', []):
        pp = strip_xrefs(p).strip()
        if pp:
            discussion += pp + '\n'
    for p in sections.get('analysis', []):
        pp = strip_xrefs(p).strip()
        if pp and not re.match(r'^\(?\d+\)?[\.\)]\s', pp):
            conclusion += pp + '\n'

    discussion = discussion.strip()
    conclusion = conclusion.strip() or 'Results validated the theoretical relationships described above.'

    tables = []
    for t in extract_tables(doc):
        tables.append({
            'title': 'Experimental Measurements',
            'headers': t['headers'] if t['headers'] else ['Parameter', 'Value'],
            'rows': t['rows'] if t['rows'] else [['', '']],
        })

    images = extract_images(fname)
    captions = find_captions(sections)
    diagrams = []
    for i, img in enumerate(images):
        cap = captions[i] if i < len(captions) else f'Figure {i + 1}'
        diagrams.append({'src': '', 'caption': cap})

    hashtags = generate_hashtags(code, title, department)

    return {
        'id': rid,
        'code': code,
        'title': title,
        'department': department,
        'level': level,
        'session': SESSION,
        'tags': hashtags,
        'verified': VERIFIED,
        'file': f"{department}/{rid}.json",
        'content': {
            'aim': aim or f'To investigate {title.lower()}.',
            'objectives': objectives or ['To carry out the experiment as outlined in the laboratory manual.'],
            'apparatus': apparatus or ['Standard laboratory equipment'],
            'theory': {'text': theory_text or 'See laboratory manual for theoretical background.', 'diagrams': diagrams},
            'tables': tables,
            'graphs': [],
            'procedure': procedure or ['Refer to laboratory experimental manual.'],
            'precautions': precautions or ['Follow standard laboratory safety procedures.'],
            'discussion': discussion,
            'conclusion': conclusion,
            'questions': [],
            'learnings': learnings or ['Applied theoretical principles to experimental measurement.'],
        },
        '_images': images,
        '_fname': fname,
    }


def save_report(report, dry_run=True):
    dept = report['department']
    rid = report['id']
    rel_file = f"{dept}/{rid}.json"
    abs_path = os.path.join(REPORTS_DIR, rel_file)

    diagrams = report['content']['theory']['diagrams']
    saved_images = []
    for i, img in enumerate(report['_images']):
        ext = img['ext']
        img_name = f"{rid}_diagram_{i + 1}{ext}"
        img_path = os.path.join(IMAGES_DIR, img_name)
        if not dry_run:
            os.makedirs(IMAGES_DIR, exist_ok=True)
            with open(img_path, 'wb') as f:
                f.write(img['data'])
        diagrams[i]['src'] = f"assets/lab_images/{img_name}"
        diagrams[i]['index'] = i + 1
        saved_images.append(img_name)

    report_out = {k: v for k, v in report.items() if k not in ('_images', '_fname')}
    for d in report_out['content']['theory']['diagrams']:
        if not d.get('caption'):
            d['caption'] = f"Figure {d.get('index', 1)}"

    if not dry_run:
        os.makedirs(os.path.dirname(abs_path), exist_ok=True)
        with open(abs_path, 'w', encoding='utf-8') as f:
            json.dump(report_out, f, ensure_ascii=False, indent=2)
            f.write('\n')
    return abs_path, saved_images


def load_index():
    if os.path.exists(INDEX_PATH):
        with open(INDEX_PATH, encoding='utf-8') as f:
            return json.load(f)
    return []


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--limit', type=int, default=None)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    dry_run = not args.apply

    all_files = sorted([f for f in os.listdir(ELA_DIR) if f.endswith('.docx')])
    combined_prefixes = ('AM_Lab_Reports', 'ELA301_Reports_Last_5_Reverse')
    individual = [f for f in all_files if not f.startswith(combined_prefixes)]

    hash_to_file = {}
    unique = []
    skipped_dupes = []
    for f in individual:
        with open(os.path.join(ELA_DIR, f), 'rb') as fh:
            h = hashlib.md5(fh.read()).hexdigest()
        if h in hash_to_file:
            skipped_dupes.append((f, hash_to_file[h]))
        else:
            hash_to_file[h] = f
            unique.append(f)
    unique.sort()

    if args.limit:
        unique = unique[:args.limit]

    print(f"=== Labroute ELA Reports Converter ===")
    print(f"Mode: {'APPLY (writing files)' if not dry_run else 'DRY-RUN (no writes)'}")
    print(f"Unique individual reports: {len(unique)}")
    print(f"Exact duplicates skipped: {len(skipped_dupes)}")
    for s, k in skipped_dupes:
        print(f"   skip {s} (dup of {k})")
    print()

    results = []
    seen_ids = set()
    skipped_same_id = []
    for fname in unique:
        try:
            report = convert_file(fname)
            if report['id'] in seen_ids:
                skipped_same_id.append(fname)
                print(f"[SKIP same report] {fname} -> already have id {report['id']}")
                continue
            seen_ids.add(report['id'])
            abs_path, saved_images = save_report(report, dry_run=dry_run)
            results.append(report)
            print(f"[OK] {fname:50} -> {report['department']}/{report['id']}.json "
                  f"(code={report['code']}, tags={len(report['tags'])}, images={len(saved_images)})")
        except Exception as e:
            print(f"[ERR] {fname:50} -> {e}")
            import traceback
            traceback.print_exc()

    if not dry_run:
        index = []
        for dept in os.listdir(REPORTS_DIR):
            dept_path = os.path.join(REPORTS_DIR, dept)
            if not os.path.isdir(dept_path):
                continue
            for fn in sorted(os.listdir(dept_path)):
                if not fn.endswith('.json'):
                    continue
                with open(os.path.join(dept_path, fn), encoding='utf-8') as f:
                    d = json.load(f)
                index.append({
                    'id': d.get('id', ''), 'code': d.get('code', ''),
                    'title': d.get('title', ''),
                    'department': d.get('department', ''), 'level': d.get('level', ''),
                    'session': d.get('session', ''), 'tags': d.get('tags', []),
                    'file': d.get('file', ''), 'verified': d.get('verified', False),
                })
        existing = load_index()
        existing_ids = {i['id'] for i in existing}
        for entry in index:
            if entry['id'] not in existing_ids:
                existing.append(entry)
        if not dry_run:
            with open(INDEX_PATH, 'w', encoding='utf-8') as f:
                json.dump(existing, f, ensure_ascii=False, indent=2)
                f.write('\n')
        print(f"\n[index.json] {len(existing)} total entries ({len(index)} new from ela-reports)")

    if skipped_same_id:
        print(f"\nSkipped {len(skipped_same_id)} additional file(s) that duplicate an already-processed report (same id).")
    print(f"\nProcessed {len(results)} unique reports.")


if __name__ == '__main__':
    main()
