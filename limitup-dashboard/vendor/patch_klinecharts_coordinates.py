#!/usr/bin/env python3
"""Apply/check the local CSS-scale input fix against vendored KLineCharts 10.1.0."""
from pathlib import Path
import argparse

NOTICE = "/*! TradingAlert modification 2026-10-26: normalize CSS-scaled pointer and pinch coordinates; see KLINECHARTS-PATCHES.md. */\n"

PATCHES = (
    (
        'var i=this,r=null!=e?e:t,n=this._target.getBoundingClientRect();return{x:r.clientX-n.left,y:r.clientY-n.top,',
        'var i=this,r=null!=e?e:t,n=this._target.getBoundingClientRect(),a=this._target.offsetWidth,o=this._target.offsetHeight,s=a>0?n.width/a:1,h=o>0?n.height/o:1;return{x:(r.clientX-n.left)/(s||1),y:(r.clientY-n.top)/(h||1),',
    ),
    (
        'var e=this._target.getBoundingClientRect();this._startPinchMiddleCoordinate={x:(t[0].clientX-e.left+(t[1].clientX-e.left))/2,y:(t[0].clientY-e.top+(t[1].clientY-e.top))/2}',
        'var e=this._target.getBoundingClientRect(),i=this._target.offsetWidth>0?e.width/this._target.offsetWidth:1,r=this._target.offsetHeight>0?e.height/this._target.offsetHeight:1;this._startPinchMiddleCoordinate={x:(t[0].clientX-e.left+(t[1].clientX-e.left))/(2*(i||1)),y:(t[0].clientY-e.top+(t[1].clientY-e.top))/(2*(r||1))}',
    ),
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Check without writing')
    args = parser.parse_args()
    path = Path(__file__).with_name('klinecharts-10.1.0.min.js')
    source = path.read_text()
    for original, patched in PATCHES:
        if source.count(patched) == 1 and source.count(original) == 0:
            continue
        if args.check:
            raise SystemExit('Coordinate fix missing; run this script without --check')
        if source.count(original) != 1 or source.count(patched) != 0:
            raise SystemExit('Unexpected vendor source; inspect the new upstream version before patching')
        source = source.replace(original, patched, 1)
    if NOTICE not in source:
        if args.check:
            raise SystemExit('Local modification notice missing')
        source = NOTICE + source
    if not args.check:
        path.write_text(source)
    print('KLineCharts CSS-scale input fix: OK')


if __name__ == '__main__':
    main()
