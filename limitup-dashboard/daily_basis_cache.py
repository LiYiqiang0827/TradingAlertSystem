"""Versioned Redis chart windows with stored offline period reuse.

The loader supplies bounded latest-adjusted daily windows and precomputed weekly
and monthly bars. Revision checks reject mixed snapshots during source updates.
The legacy incremental aggregator remains available for daily-only loaders.
"""
from __future__ import annotations
from collections import OrderedDict
import datetime as dt
import json
import threading
import time
from cache_singleflight import KeyedLocks

_CACHE_VERSION = 2
_locks = KeyedLocks()
_memory = OrderedDict()
_memory_lock = threading.RLock()
_memory_bytes = 0
_LIMIT_BYTES = 32 * 1024 * 1024


def _date(stamp):
    return dt.datetime.fromtimestamp(stamp / 1000, dt.timezone.utc).date()


def _period(day, kind):
    if kind == 'weekly': return (day-dt.timedelta(days=day.weekday())).isoformat()
    return day.strftime('%Y-%m')


def aggregate_changed(raw, previous=None):
    """Reuse untouched periods; replace affected periods from daily rows, never add twice."""
    old = (previous or {}).get('daily', [])
    old_by_day = {bar['timestamp']: bar for bar in old}
    new_by_day = {bar['timestamp']: bar for bar in raw['daily']}
    changed = {stamp for stamp in old_by_day.keys() | new_by_day.keys()
               if old_by_day.get(stamp) != new_by_day.get(stamp)}
    initial = not previous
    stats = {'mode': 'initial' if initial else 'incremental', 'changedDaily': len(changed),
             'adjustmentRebased': bool(previous and previous['adjustmentBase'] != raw['adjustmentBase'])}
    result = dict(raw)
    for kind in ('weekly', 'monthly'):
        affected = {_period(_date(stamp), kind) for stamp in changed}
        groups = {}
        for bar in raw['daily']:
            key = _period(_date(bar['timestamp']), kind)
            if key in affected: groups.setdefault(key, []).append(bar)
        periods = {_period(_date(bar['timestamp']), kind): bar
                   for bar in (previous or {}).get(kind, [])
                   if _period(_date(bar['timestamp']), kind) not in affected}
        for key, bars in groups.items():
            periods[key] = {'timestamp': bars[-1]['timestamp'], 'open': bars[0]['open'],
                            'high': max(bar['high'] for bar in bars),
                            'low': min(bar['low'] for bar in bars), 'close': bars[-1]['close'],
                            'volume': sum(bar.get('volume', 0) for bar in bars),
                            'amount': sum(bar.get('amount', 0) for bar in bars)}
        result[kind] = sorted(periods.values(), key=lambda bar: bar['timestamp'])
        stats[kind+'Updated'] = len(affected)
        stats[kind+'Reused'] = len(periods)-len(groups)
    result['aggregation'] = stats
    return result


def _remember(key, record):
    global _memory_bytes
    size = len(json.dumps(record, ensure_ascii=False, separators=(',', ':')).encode()) * 3
    if size > _LIMIT_BYTES: return
    with _memory_lock:
        prior = _memory.pop(key, None)
        if prior: _memory_bytes -= prior[1]
        _memory[key] = (record, size, time.monotonic()+600)
        _memory_bytes += size
        while len(_memory) > 64 or _memory_bytes > _LIMIT_BYTES:
            _, (_, old_size, _) = _memory.popitem(last=False); _memory_bytes -= old_size


def read_basis(cache, code, cutoff, revision_fn, loader, window="latest"):
    global _memory_bytes
    key = f'stock-daily-basis:v{_CACHE_VERSION}:{code}:{window}'
    with _locks.hold(key):
        revision = revision_fn()
        record = None
        memory_hit = False
        with _memory_lock:
            item = _memory.get(key)
            if item:
                if item[2] > time.monotonic():
                    record = item[0]; memory_hit = True; _memory.move_to_end(key)
                else: _memory.pop(key); _memory_bytes -= item[1]
        if record is None: record = cache.get(key)
        if record and record['revision'] == revision and record['cutoff'] == cutoff:
            if not memory_hit: _remember(key, record)
            return record['basis']
        # Preserve the old snapshot across revision changes for incremental aggregation.
        for attempt in range(2):
            revision = revision_fn()
            raw = loader(code, cutoff)
            if revision_fn() == revision: break
        else: raise RuntimeError('Daily source changing; temporarily unavailable')
        basis = dict(raw) if 'weekly' in raw and 'monthly' in raw else aggregate_changed(raw, record.get('basis') if record else None)
        basis['dailyDataVersion'] = revision
        if basis['daily']:
            updated = {'revision': revision, 'cutoff': cutoff, 'basis': basis}
            cache.set(key, updated, 7*24*3600)
            if cache.redis:
                # Bound only this namespace; do not change global Redis policy.
                cache.redis.eval("""redis.call('ZADD',KEYS[1],ARGV[1],ARGV[2])
                    redis.call('EXPIRE',KEYS[1],604800)
                    local old=redis.call('ZRANGE',KEYS[1],0,-121)
                    for _,key in ipairs(old) do
                        if string.sub(key,1,string.len('stock-daily-basis:v2:'))=='stock-daily-basis:v2:' then redis.call('DEL',key) end
                        redis.call('ZREM',KEYS[1],key)
                    end
                    return #old""",1,'stock-daily-records:v2',time.time(),key)
            _remember(key, updated)
        return basis
