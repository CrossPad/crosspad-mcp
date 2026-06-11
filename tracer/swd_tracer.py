#!/usr/bin/env python3
"""CrossPad SWD real-time tracer daemon (pyOCD).

Subcommands:
  symbols  --elf PATH [--query STR]      -> prints JSON {symbols:[...]} and exits
  trace    --elf PATH --signals NAMES [--rate HZ] [--out FILE] [--probe UID]
                                         -> NDJSON frames on stdout until stdin {"cmd":"stop"}
           Optional SWO/ITM:
             --swo PORT:NAME[,...]        -> EXPERIMENTAL: decode ITM stimulus ports onto named
                                            signals.  Requires firmware that emits ITM data on the
                                            SWO pin — the current CrossPad firmware does NOT do this,
                                            so this path is UNTESTED against a real ITM source.
                                            If SWV initialisation fails the daemon continues with
                                            plain RAM polling (fail-soft).
             --cpu-hz HZ                  -> core clock for SWO baud derivation (default 64000000).
             --swo-hz HZ                  -> desired SWO baud (must match firmware TPIU config,
                                            default 2000000).

Output contract: machine JSON/NDJSON on stdout, human logs on stderr ONLY.
"""
import argparse, json, sys

def log(*a):
    print(*a, file=sys.stderr, flush=True)

# DWARF DW_AT_encoding -> our tag.
_ENC = {1: "address", 2: "bool", 4: "float", 5: "int", 7: "uint", 8: "uchar", 6: "char"}

def _iter_addr_globals(dwarf):
    """Yield (name, address, die, cu) for every fixed-address global/static.

    A fixed-address variable has a DW_AT_location of the form
    DW_OP_addr (0x03) + 4-byte little-endian address.  Shared by both the flat
    `symbols` listing and the symbol-table the spec resolver walks from.
    """
    for cu in dwarf.iter_CUs():
        for die in cu.iter_DIEs():
            if die.tag != "DW_TAG_variable":
                continue
            name = die.attributes.get("DW_AT_name")
            loc = die.attributes.get("DW_AT_location")
            if not name or not loc:
                continue
            expr = loc.value
            if not isinstance(expr, list) or len(expr) != 5 or expr[0] != 0x03:
                continue
            addr = expr[1] | (expr[2] << 8) | (expr[3] << 16) | (expr[4] << 24)
            nm = name.value.decode("utf-8", "replace")
            yield nm, addr, die, cu

def resolve_symbols(elf_path, query=None):
    from elftools.elf.elffile import ELFFile
    out = []
    with open(elf_path, "rb") as f:
        elf = ELFFile(f)
        if not elf.has_dwarf_info():
            raise RuntimeError("ELF has no DWARF info (build Debug with -g).")
        dwarf = elf.get_dwarf_info()
        for nm, addr, die, cu in _iter_addr_globals(dwarf):
            if query and query.lower() not in nm.lower():
                continue
            enc, size = _resolve_type(die, cu)
            sym = {"name": nm, "address": addr, "encoding": enc, "size": size}
            # §8: best-effort richer metadata for UI autocomplete.  Never fatal —
            # on any DWARF surprise we fall back to the back-compat fields only.
            try:
                _enrich_symbol(sym, die, cu)
            except Exception:
                pass
            out.append(sym)
    # De-dup by (name,address); stable order by address.
    seen, uniq = set(), []
    for s in sorted(out, key=lambda x: x["address"]):
        k = (s["name"], s["address"])
        if k not in seen:
            seen.add(k); uniq.append(s)
    return uniq

def build_symbol_table(elf_path):
    """Map base name -> {address, type_die, cu} for every fixed-address global.

    `type_die` is the resolved DW_AT_type DIE (or None) — the entry point for the
    spec resolver's DWARF walk.  Like resolve_symbols this de-dups by name (first
    occurrence by address wins) so plain-name lookups stay deterministic.
    """
    from elftools.elf.elffile import ELFFile
    table = {}
    with open(elf_path, "rb") as f:
        elf = ELFFile(f)
        if not elf.has_dwarf_info():
            raise RuntimeError("ELF has no DWARF info (build Debug with -g).")
        dwarf = elf.get_dwarf_info()
        # Collect then sort by address so the de-dup winner is stable (lowest addr).
        rows = sorted(_iter_addr_globals(dwarf), key=lambda r: r[1])
        for nm, addr, die, cu in rows:
            if nm in table:
                continue
            t = die.attributes.get("DW_AT_type")
            type_die = cu.dwarfinfo.get_DIE_from_refaddr(t.value + cu.cu_offset) if t else None
            table[nm] = {"address": addr, "type_die": type_die, "cu": cu}
    return table

def _resolve_type(die, cu):
    """Walk DW_AT_type to a base type, returning (encoding_tag, byte_size).

    For arrays/pointers we return the underlying base-type encoding and the
    *total* byte_size of the outermost type that carries DW_AT_byte_size.
    """
    enc, size = "uint", 4
    size_set = False
    t = die.attributes.get("DW_AT_type")
    depth = 0
    while t is not None and depth < 16:
        depth += 1
        ref = cu.dwarfinfo.get_DIE_from_refaddr(t.value + cu.cu_offset)
        bs = ref.attributes.get("DW_AT_byte_size")
        if bs and not size_set:
            size = bs.value
            size_set = True
        if ref.tag == "DW_TAG_base_type":
            e = ref.attributes.get("DW_AT_encoding")
            if e:
                enc = _ENC.get(e.value, "uint")
            return enc, size
        if ref.tag == "DW_TAG_pointer_type":
            return "uint", (size if size_set else 4)
        t = ref.attributes.get("DW_AT_type")
    return enc, size

def _enrich_symbol(sym, var_die, cu):
    """Annotate a symbol dict in place with §8 metadata.

    Classifies the variable's type DIE (typedef/cv-stripped) into a `kind`:
      scalar  base/pointer/enum                       → (no extra fields)
      array   DW_TAG_array_type                        → dims,count,elem_size,elem_encoding
      struct  DW_TAG_structure_type                    → members[]
      union   DW_TAG_union_type                        → members[]
      other   anything else                            → (no extra fields)
    Best-effort: leaves `sym` untouched (kind="other") if the type can't be
    classified.  Uses the shared _array_dim_counts / _resolve_type_from helpers.
    """
    t = var_die.attributes.get("DW_AT_type")
    if t is None:
        sym["kind"] = "other"
        return
    die = cu.dwarfinfo.get_DIE_from_refaddr(t.value + cu.cu_offset)
    die = _strip_cv_typedef(die, cu)
    if die is None:
        sym["kind"] = "other"
        return
    tag = die.tag
    if tag in ("DW_TAG_base_type", "DW_TAG_pointer_type", "DW_TAG_enumeration_type"):
        sym["kind"] = "scalar"
    elif tag == "DW_TAG_array_type":
        sym["kind"] = "array"
        counts = _array_dim_counts(die, cu)
        et = die.attributes.get("DW_AT_type")
        elem = cu.dwarfinfo.get_DIE_from_refaddr(et.value + cu.cu_offset) if et else None
        elem = _strip_cv_typedef(elem, cu)
        if counts:
            prod = 1
            for c in counts:
                prod *= c
            sym["dims"] = counts
            sym["count"] = prod
        if elem is not None and elem.tag in (
                "DW_TAG_base_type", "DW_TAG_pointer_type", "DW_TAG_enumeration_type"):
            e_enc, e_size = _resolve_type_from(elem, cu)
            sym["elem_size"] = e_size
            sym["elem_encoding"] = e_enc
        else:
            es = _type_byte_size(elem, cu)
            if es is not None:
                sym["elem_size"] = es
    elif tag in ("DW_TAG_structure_type", "DW_TAG_union_type"):
        sym["kind"] = "struct" if tag == "DW_TAG_structure_type" else "union"
        members = []
        for child in die.iter_children():
            if child.tag != "DW_TAG_member":
                continue
            nm = child.attributes.get("DW_AT_name")
            if nm:
                members.append(nm.value.decode("utf-8", "replace"))
        if members:
            sym["members"] = members
    else:
        sym["kind"] = "other"

def cmd_symbols(args):
    syms = resolve_symbols(args.elf, args.query)
    print(json.dumps({"symbols": syms}))

# --- trace mode ---------------------------------------------------------------
import io, os, re, struct, threading, time

def _try_open_session(probe, target, timeout_s):
    """Open a pyOCD session with a hard timeout and no-probe fast-fail.

    Returns (session_or_None, error_str_or_None, timed_out_bool). The connect
    work (USB enumeration + session.open()) runs in a daemon worker thread so a
    libusb wedge cannot hang the process forever — if the worker doesn't finish
    within timeout_s it is abandoned (uninterruptible C) and we report a timeout.

    `blocking=False, return_first=True` makes a MISSING probe return immediately
    instead of pyOCD blocking forever waiting for one to be plugged in.
    """
    from pyocd.core.helpers import ConnectHelper
    holder = {}

    def opener():
        # pyOCD prints "No connected debug probes" (and possibly probe-selection
        # chatter) directly to stdout via print() — NOT through logging. stdout is
        # our machine-JSON channel, so redirect it to stderr for the duration of
        # the connect. Safe: main() is blocked in th.join() here, so nothing else
        # writes stdout concurrently; we restore it before returning.
        saved_stdout = sys.stdout
        sys.stdout = sys.stderr
        try:
            s = ConnectHelper.session_with_chosen_probe(
                blocking=False, return_first=True,
                unique_id=probe or None,
                # connect_mode='attach' = do NOT halt the core (pyOCD default
                # 'halt' freezes RAM so every poll reads stale values).
                options={"target_override": target, "connect_mode": "attach"})
            if s is None:
                holder["noprobe"] = True
                return
            s.open()
            holder["session"] = s
        except BaseException as e:  # capture everything from the worker thread
            holder["error"] = e
        finally:
            sys.stdout = saved_stdout

    th = threading.Thread(target=opener, daemon=True)
    th.start()
    th.join(timeout_s)
    if th.is_alive():
        return None, "connect timeout after %gs (probe wedged? replug ST-Link)" % timeout_s, True
    if holder.get("noprobe"):
        return None, "no debug probe detected (replug ST-Link)", False
    if "error" in holder:
        return None, str(holder["error"]), False
    return holder["session"], None, False

# ---------------------------------------------------------------------------
# EXPERIMENTAL: SWO / ITM sink (only used when --swo is passed)
# ---------------------------------------------------------------------------

class _ITMValueSink:
    """Collects the latest ITM stimulus-port word.

    Implements the TraceEventSink interface (receive(event)) without
    subclassing so that the import of pyocd.trace.sink is deferred to the
    --swo code path and never touched on the negative (plain-polling) path.

    Thread-safe-ish: dict writes are GIL-guarded on CPython.
    """
    def __init__(self):
        self.latest = {}  # port:int -> value:int

    def receive(self, event):
        try:
            from pyocd.trace.events import TraceITMEvent
            if isinstance(event, TraceITMEvent):
                self.latest[event.port] = event.data
        except Exception:
            pass  # never crash the probe thread


def _setup_swo(session, cpu_hz, swo_hz):
    """Wire up SWVReader with our custom ITM sink.

    Strategy: call SWVReader.init() with a dummy StringIO console (so the
    standard SWVEventSink is constructed), then immediately replace the
    parser's connected sink with our own _ITMValueSink.  This is the only
    way to inject a custom sink given pyOCD 0.44's SWVReader.init() API
    (signature: init(sys_clock, swo_clock, console:TextIO) -> bool).

    Returns (reader, sink) on success, (None, None) on any failure.
    The function is fail-soft: it logs to stderr and never raises.
    """
    try:
        from pyocd.trace.swv import SWVReader
        sink = _ITMValueSink()
        reader = SWVReader(session, 0)
        dummy_console = io.StringIO()
        ok = reader.init(cpu_hz, swo_hz, dummy_console)
        if not ok:
            # init() already printed a pyOCD warning; add our own context.
            log("[swo] SWVReader.init() returned False (probe/target may lack SWO support); "
                "continuing with plain RAM polling only.")
            return None, None
        # Redirect the parser's downstream sink to ours.
        # reader._parser is a SWOParser; SWOParser.connect(sink) replaces _sink.
        reader._parser.connect(sink)
        log(f"[swo] SWV reader started (cpu_hz={cpu_hz}, swo_hz={swo_hz}); "
            "ITM data will be merged into sample frames when available.")
        return reader, sink
    except Exception as e:
        log(f"[swo] setup failed, continuing with polling only: {e}")
        return None, None

_NP = struct.Struct("<I")  # little-endian u32 for the file header length prefix

# Spec grammar (PROTOCOL.md §1 + §1.1):
#   base ( .member | [int] | [*] | [a:b] )*
# Base name first, then an ordered list of accessors.  The wildcard/slice forms
# ([*], [a:b]) and a bare/trailing array dimension drive expansion (§1.1).
_BASE_RE = re.compile(r"^([A-Za-z_]\w*)")
# Order matters: try the wildcard/slice forms before the plain [int] alternative.
_ACCESS_RE = re.compile(
    r"\.([A-Za-z_]\w*)"          # 1: .member
    r"|\[(\*)\]"                  # 2: [*]  (whole dimension)
    r"|\[(\d+):(\d+)\]"          # 3,4: [a:b]  (half-open slice)
    r"|\[(\d+)\]")               # 5: [int]

def _tokenize_spec(spec):
    """Split a spec into (base, [accessors]).

    Returns (base:str, accessors:list) where each accessor is one of:
      ('member', name)         .member
      ('index', int)           [i]
      ('all',)                 [*]   — whole dimension (expansion)
      ('slice', a, b)          [a:b] — half-open slice (expansion)
    Returns None on any syntax error (stray characters, empty base, malformed
    accessor).
    """
    m = _BASE_RE.match(spec)
    if not m:
        return None
    base = m.group(1)
    pos = m.end()
    accessors = []
    while pos < len(spec):
        am = _ACCESS_RE.match(spec, pos)
        if not am:
            return None
        if am.group(1) is not None:
            accessors.append(("member", am.group(1)))
        elif am.group(2) is not None:
            accessors.append(("all",))
        elif am.group(3) is not None:
            accessors.append(("slice", int(am.group(3)), int(am.group(4))))
        else:
            accessors.append(("index", int(am.group(5))))
        pos = am.end()
    return base, accessors

def _strip_cv_typedef(die, cu):
    """Follow DW_TAG_typedef / const / volatile / restrict wrappers transparently.

    Returns the first underlying DIE that is not one of those wrappers (or None
    if the chain dead-ends without a DW_AT_type).
    """
    transparent = ("DW_TAG_typedef", "DW_TAG_const_type",
                   "DW_TAG_volatile_type", "DW_TAG_restrict_type")
    depth = 0
    while die is not None and die.tag in transparent and depth < 16:
        depth += 1
        t = die.attributes.get("DW_AT_type")
        if t is None:
            return None
        die = cu.dwarfinfo.get_DIE_from_refaddr(t.value + cu.cu_offset)
    return die

def _type_byte_size(die, cu):
    """Best-effort total byte size of a type DIE (follows wrappers / pointers)."""
    depth = 0
    while die is not None and depth < 16:
        depth += 1
        bs = die.attributes.get("DW_AT_byte_size")
        if bs:
            return bs.value
        if die.tag == "DW_TAG_pointer_type":
            return 4
        t = die.attributes.get("DW_AT_type")
        if t is None:
            return None
        die = cu.dwarfinfo.get_DIE_from_refaddr(t.value + cu.cu_offset)
    return None

def _member_offset(member_die):
    """DW_AT_data_member_location -> int byte offset.

    Handles the common encodings: a plain integer, or a DWARF location
    expression of the form [DW_OP_plus_uconst (0x23), N].  Returns None if the
    form is unrecognised.
    """
    loc = member_die.attributes.get("DW_AT_data_member_location")
    if loc is None:
        return 0  # absent => offset 0 (e.g. first member / union member)
    v = loc.value
    if isinstance(v, int):
        return v
    if isinstance(v, list) and len(v) >= 2 and v[0] == 0x23:
        return v[1]
    return None

def _find_member(struct_die, name):
    """Return the DW_TAG_member child of a struct/union DIE matching `name`."""
    for child in struct_die.iter_children():
        if child.tag != "DW_TAG_member":
            continue
        nm = child.attributes.get("DW_AT_name")
        if nm and nm.value.decode("utf-8", "replace") == name:
            return child
    return None

def _resolve_spec(spec, table):
    """Resolve a full spec against build_symbol_table() output.

    Walks DWARF from the base type DIE applying each accessor:
      [i]      consumes one DW_TAG_array_type dimension (subrange child),
               stride = element type byte size; multi-dim arrays expressed as
               multiple DW_TAG_subrange_type children are consumed left-to-right.
      .member  consumes a DW_TAG_structure_type / DW_TAG_union_type member,
               offset from DW_AT_data_member_location.
    The final node must resolve to a scalar (base type / pointer / enum);
    otherwise the spec is unresolved.  Returns {name,address,size,encoding} or None.
    """
    tok = _tokenize_spec(spec)
    if tok is None:
        return None
    base, accessors = tok
    entry = table.get(base)
    if not entry:
        return None
    addr = entry["address"]
    cu = entry["cu"]
    cur = _strip_cv_typedef(entry["type_die"], cu)

    # Pending array dimensions: when an array_type is reached we expand its
    # subrange children into a list of (stride, count) consumed by successive [i].
    pending_dims = []  # list of (stride_bytes, count) tuples, outer-to-inner
                       # count==0 means the bound is unknown (no validation possible)
    pending_elem = None  # element type DIE once the dim list is exhausted

    def _load_array(arr_die):
        """Populate pending_dims/pending_elem from a DW_TAG_array_type."""
        nonlocal pending_dims, pending_elem
        et = arr_die.attributes.get("DW_AT_type")
        elem = cu.dwarfinfo.get_DIE_from_refaddr(et.value + cu.cu_offset) if et else None
        elem = _strip_cv_typedef(elem, cu)
        subranges = [c for c in arr_die.iter_children()
                     if c.tag == "DW_TAG_subrange_type"]
        elem_size = _type_byte_size(elem, cu)
        if elem_size is None:
            return False
        # Strides: innermost dimension has stride=elem_size; each outer dimension
        # multiplies by the inner dimension's element count.
        counts = []
        for sr in subranges:
            ub = sr.attributes.get("DW_AT_upper_bound")
            cnt = sr.attributes.get("DW_AT_count")
            if cnt is not None and isinstance(cnt.value, int):
                counts.append(cnt.value)
            elif ub is not None and isinstance(ub.value, int):
                counts.append(ub.value + 1)
            else:
                counts.append(0)  # unknown bound; stride math below still works
        if not subranges:
            counts = [0]
        strides = [0] * len(counts)
        acc = elem_size
        for i in range(len(counts) - 1, -1, -1):
            strides[i] = acc
            acc *= counts[i] if counts[i] else 1
        pending_dims = list(zip(strides, counts))
        pending_elem = elem
        return True

    for acc in accessors:
        if cur is None and not pending_dims:
            return None
        if acc[0] == "index":
            # Need an array dimension to consume.
            if not pending_dims:
                cur = _strip_cv_typedef(cur, cu)
                if cur is None or cur.tag != "DW_TAG_array_type":
                    return None
                if not _load_array(cur):
                    return None
            stride, count = pending_dims.pop(0)
            # Reject out-of-bounds indices when the bound is known (count>0) — a
            # firmware-symbol tracer must not silently read adjacent RAM. With an
            # unknown bound (count==0) we keep the raw stride arithmetic.
            if count and not (0 <= acc[1] < count):
                return None
            addr += acc[1] * stride
            if not pending_dims:
                cur = pending_elem
                pending_elem = None
        else:  # member
            if pending_dims:
                return None  # can't take .member with array dims still pending
            cur = _strip_cv_typedef(cur, cu)
            if cur is None or cur.tag not in ("DW_TAG_structure_type", "DW_TAG_union_type"):
                return None
            found = None
            for child in cur.iter_children():
                if child.tag != "DW_TAG_member":
                    continue
                nm = child.attributes.get("DW_AT_name")
                if nm and nm.value.decode("utf-8", "replace") == acc[1]:
                    found = child
                    break
            if found is None:
                return None
            off = _member_offset(found)
            if off is None:
                return None
            addr += off
            mt = found.attributes.get("DW_AT_type")
            cur = cu.dwarfinfo.get_DIE_from_refaddr(mt.value + cu.cu_offset) if mt else None
            cur = _strip_cv_typedef(cur, cu)

    if pending_dims:
        return None  # spec stopped mid-array → still an aggregate
    cur = _strip_cv_typedef(cur, cu)
    if cur is None:
        return None
    # Final node must be a scalar.
    if cur.tag not in ("DW_TAG_base_type", "DW_TAG_pointer_type", "DW_TAG_enumeration_type"):
        return None
    enc, size = _resolve_type_from(cur, cu)
    return {"name": spec, "address": addr, "size": size, "encoding": enc}

EXPAND_CAP = 256  # PROTOCOL §1.1: expansions larger than this are skipped.

def _array_dim_counts(arr_die, cu):
    """Per-dimension element counts of a DW_TAG_array_type (outer-to-inner).

    Returns [] if any bound is unknown / unbounded (count==0) so callers can
    refuse to expand an array whose size DWARF doesn't pin down.
    """
    counts = []
    for sr in arr_die.iter_children():
        if sr.tag != "DW_TAG_subrange_type":
            continue
        ub = sr.attributes.get("DW_AT_upper_bound")
        cnt = sr.attributes.get("DW_AT_count")
        if cnt is not None and isinstance(cnt.value, int):
            counts.append(cnt.value)
        elif ub is not None and isinstance(ub.value, int):
            counts.append(ub.value + 1)
        else:
            return []  # unknown bound → not expandable
    return counts

def _spec_name(base, parts):
    """Re-render a base name + concrete accessor parts into a spec string.

    `parts` items are ('index', i) or ('member', name); rendered as
    base[i][j].member ... matching the §1.1 concrete-element form.
    """
    s = base
    for p in parts:
        s += ("[%d]" % p[1]) if p[0] == "index" else ("." + p[1])
    return s

def _expand_spec(spec, table):
    """Expand a (possibly array-bearing) spec into concrete scalar specs.

    Walks the DWARF type chain following the tokenized accessors.  Whenever a
    dimension must be materialised — an explicit `[*]`/`[a:b]`, a bare/trailing
    array, or an array dim sitting in front of a `.member` — it enumerates the
    selected indices and recurses, producing concrete `name[i]` / `name[i][j]`
    forms.  Returns (specs:list[str], count_estimate:int).

    `count_estimate` is the total number of concrete elements the spec would
    yield (used by the caller for the §1.1 256-cap report).  On any
    unexpandable / malformed input returns ([], 0) — the caller then treats the
    spec as a plain unresolved scalar.
    """
    tok = _tokenize_spec(spec)
    if tok is None:
        return [], 0
    base, accessors = tok
    entry = table.get(base)
    if not entry:
        return [], 0
    cu = entry["cu"]

    def _idxs_for(acc, n):
        """Resolve one index/all/slice accessor against a dimension of size n.

        Returns the list of concrete indices, or None if `acc` is an out-of-range
        index (a hard failure for that branch).
        """
        if acc[0] == "index":
            return [acc[1]] if 0 <= acc[1] < n else None
        if acc[0] == "all":
            return list(range(n))
        # slice a:b — half-open, clamped to [0, n).
        a, b = max(0, acc[1]), min(n, acc[2])
        return list(range(a, b)) if b > a else []

    # Walk the type chain.  `cur` is the current type DIE (cv/typedef-stripped),
    # `ai` the next accessor to apply, `parts` the concrete accessor prefix built
    # so far.  Returns a list of concrete accessor-part lists, or None on a hard
    # mismatch (the spec is unexpandable / out of range).
    def walk(cur, ai, parts):
        cur = _strip_cv_typedef(cur, cu)
        if cur is None:
            return None

        if cur.tag == "DW_TAG_array_type":
            # Enumerate this array's dimensions (it may carry several subranges).
            counts = _array_dim_counts(cur, cu)
            if not counts:
                return None
            et = cur.attributes.get("DW_AT_type")
            elem = cu.dwarfinfo.get_DIE_from_refaddr(et.value + cu.cu_offset) if et else None
            return walk_dims(counts, 0, elem, ai, parts)

        if ai < len(accessors):
            acc = accessors[ai]
            if acc[0] != "member":
                return None  # an index/all/slice on a non-array → mismatch
            if cur.tag not in ("DW_TAG_structure_type", "DW_TAG_union_type"):
                return None
            member = _find_member(cur, acc[1])
            if member is None:
                return None
            mt = member.attributes.get("DW_AT_type")
            mtd = cu.dwarfinfo.get_DIE_from_refaddr(mt.value + cu.cu_offset) if mt else None
            return walk(mtd, ai + 1, parts + [("member", acc[1])])

        # No more accessors and not an array → scalar element or dead end.
        if cur.tag in ("DW_TAG_base_type", "DW_TAG_pointer_type", "DW_TAG_enumeration_type"):
            return [parts]
        return None  # struct/union with no trailing array → unresolved

    def walk_dims(counts, dim, elem, ai, parts):
        """Enumerate dimension `dim` of an array (counts = per-dim sizes).

        A following index/all/slice accessor selects the indices for this dim and
        is consumed (ai advances); otherwise the whole dimension is enumerated and
        ai is preserved (so a trailing `.member` applies after the dims are gone).
        Recurses into inner dims, then back into walk() for the element type.
        """
        n = counts[dim]
        if n == 0:
            return None
        if ai < len(accessors) and accessors[ai][0] in ("index", "all", "slice"):
            idxs = _idxs_for(accessors[ai], n)
            if idxs is None:
                return None
            ai2 = ai + 1
        else:
            idxs = list(range(n))
            ai2 = ai
        out = []
        for i in idxs:
            p = parts + [("index", i)]
            if dim + 1 < len(counts):
                sub = walk_dims(counts, dim + 1, elem, ai2, p)
            else:
                sub = walk(elem, ai2, p)
            if sub is None:
                return None
            out.extend(sub)
        return out

    cur0 = _strip_cv_typedef(entry["type_die"], cu)
    parts_lists = walk(cur0, 0, [])
    if not parts_lists:
        return [], 0
    specs = [_spec_name(base, p) for p in parts_lists]
    return specs, len(specs)

def _resolve_specs(specs, table):
    """Resolve a list of specs, applying §1.1 array/vector/matrix expansion.

    For each spec: first try the expander.  If it yields >1 element (or exactly
    one but via a wildcard/slice/trailing array) those concrete element specs
    are resolved individually.  A plain scalar spec falls through to
    _resolve_spec.  Returns (resolved:list[dict], unresolved:list[str]).

    Cap (§1.1): an expansion exceeding EXPAND_CAP elements is skipped and
    reported as "<spec> (expands to <N> > 256)".
    """
    resolved, unresolved = [], []
    for spec in specs:
        elems, n = _expand_spec(spec, table)
        if n > EXPAND_CAP:
            unresolved.append("%s (expands to %d > %d)" % (spec, n, EXPAND_CAP))
            continue
        if elems:
            # Expanded (possibly to a single concrete element). Resolve each;
            # any element that fails to resolve is silently dropped (the spec as
            # a whole produced concrete names, so it isn't "unresolved").
            for e in elems:
                r = _resolve_spec(e, table)
                if r:
                    resolved.append(r)
            continue
        # Not expandable — try as a plain concrete scalar spec.
        r = _resolve_spec(spec, table)
        if r:
            resolved.append(r)
        else:
            unresolved.append(spec)
    return resolved, unresolved

def _resolve_type_from(die, cu):
    """Encoding/size of a scalar type DIE (base/pointer/enum).

    Mirrors _resolve_type but starts from an already-resolved type DIE rather
    than from a variable DIE's DW_AT_type.
    """
    if die.tag == "DW_TAG_pointer_type":
        bs = die.attributes.get("DW_AT_byte_size")
        return "uint", (bs.value if bs else 4)
    if die.tag == "DW_TAG_base_type":
        e = die.attributes.get("DW_AT_encoding")
        enc = _ENC.get(e.value, "uint") if e else "uint"
        bs = die.attributes.get("DW_AT_byte_size")
        return enc, (bs.value if bs else 4)
    if die.tag == "DW_TAG_enumeration_type":
        bs = die.attributes.get("DW_AT_byte_size")
        return "int", (bs.value if bs else 4)
    bs = die.attributes.get("DW_AT_byte_size")
    return "uint", (bs.value if bs else 4)

def _coalesce(sigs):
    """sigs: list of {name,address,size,encoding}. Returns [(start,length,[(name,off,size,enc)])]."""
    items = sorted(sigs, key=lambda s: s["address"])
    ranges = []
    for s in items:
        a, ln = s["address"], s["size"]
        if ranges and a <= ranges[-1][0] + ranges[-1][1] + 4:  # merge if within 4 bytes of prev end
            start, length, members = ranges[-1]
            new_end = max(start + length, a + ln)
            ranges[-1] = (start, new_end - start, members + [(s["name"], a - start, ln, s["encoding"])])
        else:
            ranges.append((a, ln, [(s["name"], 0, ln, s["encoding"])]))
    return ranges

def _decode(buf, off, size, enc):
    raw = bytes(buf[off:off + size])
    if enc == "float" and size == 4:
        return struct.unpack("<f", raw)[0]
    if enc == "float" and size == 8:
        return struct.unpack("<d", raw)[0]
    signed = enc in ("int", "char")
    return int.from_bytes(raw, "little", signed=signed)

def cmd_trace(args):
    names = [n for n in args.signals.split(",") if n]
    # §11.3 ELF / DWARF guard: a bad/missing ELF must surface as an error frame,
    # not a raw traceback to stderr that leaves the TS layer guessing.
    try:
        table = build_symbol_table(args.elf)
    except Exception as e:
        print(json.dumps({"type": "error", "error": "ELF/DWARF error: %s" % e}), flush=True)
        return
    # §1.1: expand whole-array / vector / matrix specs into concrete elements.
    resolved, missing = _resolve_specs(names, table)
    if not resolved:
        # Nothing resolved at all → hard error (matches the old all-missing path).
        print(json.dumps({"type": "error", "error": "unknown symbols: " + ",".join(missing)}), flush=True)
        return
    # Any specs that failed to resolve/expand are reported via the live "signals"
    # frame's `unresolved`, not as a fatal error (mirrors the add path).
    initial_unresolved = list(missing)

    # Live poll set, mutated by the stdin reader thread (add/remove). Guarded by
    # a lock; the poll loop re-coalesces ranges whenever `dirty` is set.
    state_lock = threading.Lock()
    # name -> {name,address,size,encoding}; ordered insertion preserves request order.
    sigset = {s["name"]: s for s in resolved}
    state = {"dirty": True, "ranges": _coalesce(list(sigset.values())),
             "unresolved": initial_unresolved, "signals": list(sigset.values())}

    def _signals_frame():
        """Build the {"type":"signals",...} frame from the current poll set."""
        with state_lock:
            sigs = [{"name": s["name"], "address": s["address"],
                     "size": s["size"], "encoding": s["encoding"]} for s in state["signals"]]
            unres = list(state["unresolved"])
        return {"type": "signals", "signals": sigs, "unresolved": unres}

    # --- EXPERIMENTAL: parse --swo mapping (negative path: swo_map is empty) ---
    swo_map = {}  # port:int -> signal_name:str
    if args.swo:
        for spec in args.swo.split(","):
            spec = spec.strip()
            if not spec:
                continue
            try:
                port_str, sig_name = spec.split(":", 1)
                swo_map[int(port_str)] = sig_name
            except (ValueError, TypeError):
                log(f"[swo] ignoring malformed port:name spec: {spec!r}")
        if swo_map:
            log(f"[swo] EXPERIMENTAL: ITM port mapping: {swo_map}  "
                "(requires firmware that emits ITM on SWO — NOT present in current CrossPad firmware)")

    # NOTE: the .cptrace file header is written ONCE here with the initial set.
    # add/remove on a live trace change the live poll set (and the NDJSON
    # "signals" frames) but deliberately do NOT rewrite this on-disk header — the
    # header reflects the trace's *initial* signal set only.
    fh = open(args.out, "wb") if args.out else None
    if fh:
        hdr = json.dumps({"signals": [{"name": s["name"], "encoding": s["encoding"], "size": s["size"]} for s in resolved]}).encode()
        fh.write(b"CPTR"); fh.write(_NP.pack(len(hdr))); fh.write(hdr)

    target_dt = 1.0 / args.rate if args.rate > 0 else 0.0
    stop = {"v": False}

    def _apply_add(specs):
        # §1.1: expansion applies to live add too, so the emitted "signals"
        # frame lists the concrete expanded element names.
        added, unres = _resolve_specs(specs, table)
        with state_lock:
            for r in added:
                sigset[r["name"]] = r  # replace/insert
            state["signals"] = list(sigset.values())
            state["unresolved"] = unres
            state["dirty"] = True

    def _apply_remove(specs):
        with state_lock:
            for spec in specs:
                sigset.pop(spec, None)  # no-op if absent
            state["signals"] = list(sigset.values())
            state["dirty"] = True

    def stdin_reader():
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except Exception:
                continue
            cmd = msg.get("cmd")
            if cmd == "stop":
                stop["v"] = True
                return
            elif cmd == "add":
                sigs = msg.get("signals")
                if isinstance(sigs, list):
                    _apply_add([s for s in sigs if isinstance(s, str)])
            elif cmd == "remove":
                sigs = msg.get("signals")
                if isinstance(sigs, list):
                    _apply_remove([s for s in sigs if isinstance(s, str)])
    threading.Thread(target=stdin_reader, daemon=True).start()

    log(f"connecting probe (serial={args.probe or 'auto'}, target={args.target}, "
        f"connect_timeout={args.connect_timeout}s)...")
    n = 0

    # §11.1 connect with hard timeout + no-probe fast-fail. A wedged libusb open()
    # cannot be interrupted, so on timeout we flush the error frame and os._exit —
    # the OS reclaims the abandoned worker thread. Never hang here.
    session, cerr, timed_out = _try_open_session(args.probe, args.target, args.connect_timeout)
    if session is None:
        log(f"trace connect failed: {cerr}")
        print(json.dumps({"type": "error", "error": cerr}), flush=True)
        if fh:
            fh.close()
        sys.stdout.flush(); sys.stderr.flush()
        if timed_out:
            os._exit(2)          # worker wedged in C — only safe recovery
        os._exit(3 if "no debug probe" in cerr else 1)

    target = session.target
    log("connected; polling (non-halting)")
    # §11.2 persistent-fault tracking: a single read fault = stop_suspected, but
    # faults lasting longer than --lost-timeout mean the probe/target is gone.
    fault_since = None
    lost = False

    # --- EXPERIMENTAL: set up SWV reader (only when --swo was given) ---
    swo_reader, swo_sink = None, None
    if swo_map:
        swo_reader, swo_sink = _setup_swo(session, args.cpu_hz, args.swo_hz)
        # If _setup_swo failed, swo_reader/swo_sink are both None and the loop
        # below behaves identically to the no-swo path.

    t0 = time.monotonic()
    try:
        while not stop["v"]:
            cyc = time.monotonic()
            # Re-coalesce when the poll set changed, and (re)emit the "signals"
            # frame. dirty is preset True so this fires ONCE right after connect.
            if state["dirty"]:
                with state_lock:
                    state["ranges"] = _coalesce(list(state["signals"]))
                    state["dirty"] = False
                print(json.dumps(_signals_frame()), flush=True)
            ranges = state["ranges"]
            values, in_stop = {}, False
            for (start, length, members) in ranges:
                try:
                    data = target.read_memory_block8(start, length)
                except Exception:
                    in_stop = True
                    break
                for (name, off, size, enc) in members:
                    values[name] = _decode(data, off, size, enc)
            t = time.monotonic() - t0
            if in_stop:
                now = time.monotonic()
                if fault_since is None:
                    fault_since = now
                elif now - fault_since > args.lost_timeout:
                    # §11.2 persistent read fault → probe/target lost; stop looping.
                    msg = "probe/target lost (persistent read fault %.1fs)" % (now - fault_since)
                    log(msg)
                    print(json.dumps({"type": "status", "device_state": "probe_lost", "t": round(t, 6)}), flush=True)
                    print(json.dumps({"type": "error", "error": msg}), flush=True)
                    lost = True
                    break
                print(json.dumps({"type": "status", "device_state": "stop_suspected", "t": round(t, 6)}), flush=True)
                time.sleep(0.2)
                continue
            fault_since = None  # a successful read clears the fault timer

            # --- EXPERIMENTAL: merge ITM values (no-op when swo_sink is None) ---
            if swo_sink is not None:
                for port, sig_name in swo_map.items():
                    v = swo_sink.latest.get(port)
                    if v is not None:
                        values[sig_name] = v

            print(json.dumps({"type": "sample", "t": round(t, 6), "values": values}), flush=True)
            if fh:
                fh.write(json.dumps({"t": round(t, 6), "v": values}).encode() + b"\n")
            n += 1
            if target_dt:
                slp = target_dt - (time.monotonic() - cyc)
                if slp > 0:
                    time.sleep(slp)
    except Exception as e:
        log(f"trace run failed: {e}")
        print(json.dumps({"type": "error", "error": str(e)}), flush=True)
    finally:
        if swo_reader is not None:
            try:
                swo_reader.stop()
                log("[swo] SWV reader stopped.")
            except Exception as e:
                log(f"[swo] error stopping SWV reader (ignored): {e}")
        try:
            session.close()
        except Exception:
            pass
        if fh:
            fh.close()
    if not lost:
        log(f"stopped after {n} samples")
        print(json.dumps({"type": "status", "device_state": "stopped", "samples": n}), flush=True)

# --- device-state mode -------------------------------------------------------

_REGS = {
    "PWR_CR1":   0x40007000,
    "PWR_SR1":   0x40007010,
    "RCC_CR":    0x40021000,
    "RCC_CFGR":  0x40021008,
    "SCB_SCR":   0xE000ED10,
    "DBGMCU_CR": 0x40015804,
}

def cmd_device_state(args):
    out = {"type": "device_state", "regs": {}, "decoded": {}, "accessible": True}
    # §11.1: same hard-timeout / no-probe fast-fail as trace, but graceful — a
    # one-shot read reports inaccessible instead of os._exit. The wedged worker
    # (if any) is a daemon thread, abandoned on process exit.
    session, cerr, _timed_out = _try_open_session(args.probe, args.target, args.connect_timeout)
    if session is None:
        out["accessible"] = False
        out["error"] = cerr
        print(json.dumps(out), flush=True)
        return
    try:
        t = session.target
        for name, addr in _REGS.items():
            try:
                out["regs"][name] = t.read32(addr)
            except Exception:
                out["regs"][name] = None
                out["accessible"] = False
        scr = out["regs"].get("SCB_SCR") or 0
        out["decoded"]["SLEEPDEEP"] = bool(scr & (1 << 2))
        cr1 = out["regs"].get("PWR_CR1") or 0
        out["decoded"]["LPMS"] = cr1 & 0x7  # low-power mode select (STM32G0 PWR_CR1[2:0])
        out["decoded"]["interpretation"] = (
          "STOP/low-power likely" if out["decoded"]["SLEEPDEEP"] else "run/sleep")
    except Exception as e:
        out["accessible"] = False
        out["error"] = str(e)
    finally:
        try:
            session.close()
        except Exception:
            pass
    print(json.dumps(out), flush=True)

def main():
    # Claim the root logger with a stderr handler BEFORE pyOCD is imported, so
    # pyOCD's own logging (e.g. the coloured "No connected debug probes" notice)
    # cannot leak onto stdout — the stdout channel is machine JSON ONLY (§ output
    # contract). level=ERROR also mutes pyOCD's routine warnings.
    import logging
    logging.basicConfig(stream=sys.stderr, level=logging.ERROR)

    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sp = sub.add_parser("symbols")
    sp.add_argument("--elf", required=True)
    sp.add_argument("--query", default=None)
    sp.set_defaults(func=cmd_symbols)

    tp = sub.add_parser("trace")
    tp.add_argument("--elf", required=True)
    tp.add_argument("--signals", required=True)
    tp.add_argument("--rate", type=float, default=0.0)  # 0 = as fast as possible
    tp.add_argument("--out", default=None)
    tp.add_argument("--probe", default=None)
    tp.add_argument("--target", default="cortex_m",
                    help="pyOCD target_override. Default 'cortex_m' (generic; no CMSIS pack needed, "
                         "sufficient for RAM polling). For part-specific features install the pack "
                         "(pyocd pack install stm32g0b1) and pass e.g. --target stm32g0b1retx.")
    tp.add_argument("--swo", default=None,
                    help="EXPERIMENTAL: comma list of port:name mappings for ITM stimulus ports, "
                         "e.g. '0:phase,1:isr_us'.  Requires firmware that emits ITM data on the "
                         "SWO pin (NOT present in current CrossPad firmware — UNTESTED against real "
                         "ITM).  Omit for plain RAM polling.  If SWV init fails the daemon continues "
                         "polling (fail-soft).")
    tp.add_argument("--cpu-hz", type=int, default=64_000_000,
                    help="Core clock frequency in Hz for SWO baud derivation (SWO path only). "
                         "Default 64000000 (STM32G0 max).  Must match the actual firmware clock — "
                         "CrossPad r20 runs at 64 MHz but confirm in the .ioc/.clock config.")
    tp.add_argument("--swo-hz", type=int, default=2_000_000,
                    help="Desired SWO output baud in Hz (SWO path only). Default 2000000. "
                         "Must match the TPIU_ACPR configuration in the firmware.")
    tp.add_argument("--connect-timeout", type=float, default=8.0,
                    help="§11.1: hard cap (s) on probe connect. A missing probe fails fast; "
                         "a wedged libusb open() past this triggers an error frame + os._exit. "
                         "Never hang. Default 8.")
    tp.add_argument("--lost-timeout", type=float, default=10.0,
                    help="§11.2: after this many seconds of continuous read faults the "
                         "probe/target is declared lost (error frame + exit) instead of "
                         "looping stop_suspected forever. Default 10.")
    tp.set_defaults(func=cmd_trace)

    dp = sub.add_parser("device-state")
    dp.add_argument("--probe", default=None)
    dp.add_argument("--target", default="cortex_m")
    dp.add_argument("--connect-timeout", type=float, default=6.0,
                    help="§11.1: hard cap (s) on probe connect for the one-shot device-state "
                         "read. Reports inaccessible on timeout/no-probe. Default 6.")
    dp.set_defaults(func=cmd_device_state)

    args = ap.parse_args()
    args.func(args)

if __name__ == "__main__":
    main()
