#!/usr/bin/env python3
"""CrossPad SWD real-time tracer daemon (pyOCD).

Subcommands:
  symbols  --elf PATH [--query STR]      -> prints JSON {symbols:[...]} and exits

Output contract: machine JSON on stdout, human logs on stderr ONLY.
"""
import argparse, json, sys

def log(*a):
    print(*a, file=sys.stderr, flush=True)

# DWARF DW_AT_encoding -> our tag.
_ENC = {1: "address", 2: "bool", 4: "float", 5: "int", 7: "uint", 8: "uchar", 6: "char"}

def resolve_symbols(elf_path, query=None):
    from elftools.elf.elffile import ELFFile
    out = []
    with open(elf_path, "rb") as f:
        elf = ELFFile(f)
        if not elf.has_dwarf_info():
            raise RuntimeError("ELF has no DWARF info (build Debug with -g).")
        dwarf = elf.get_dwarf_info()
        for cu in dwarf.iter_CUs():
            for die in cu.iter_DIEs():
                if die.tag != "DW_TAG_variable":
                    continue
                name = die.attributes.get("DW_AT_name")
                loc = die.attributes.get("DW_AT_location")
                if not name or not loc:
                    continue
                # Only fixed-address globals/statics: DW_OP_addr (0x03) + 4-byte little-endian addr.
                expr = loc.value
                if not isinstance(expr, list) or len(expr) != 5 or expr[0] != 0x03:
                    continue
                addr = expr[1] | (expr[2] << 8) | (expr[3] << 16) | (expr[4] << 24)
                nm = name.value.decode("utf-8", "replace")
                if query and query.lower() not in nm.lower():
                    continue
                enc, size = _resolve_type(die, cu)
                out.append({"name": nm, "address": addr, "encoding": enc, "size": size})
    # De-dup by (name,address); stable order by address.
    seen, uniq = set(), []
    for s in sorted(out, key=lambda x: x["address"]):
        k = (s["name"], s["address"])
        if k not in seen:
            seen.add(k); uniq.append(s)
    return uniq

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

def cmd_symbols(args):
    syms = resolve_symbols(args.elf, args.query)
    print(json.dumps({"symbols": syms}))

def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sp = sub.add_parser("symbols")
    sp.add_argument("--elf", required=True)
    sp.add_argument("--query", default=None)
    sp.set_defaults(func=cmd_symbols)
    args = ap.parse_args()
    args.func(args)

if __name__ == "__main__":
    main()
