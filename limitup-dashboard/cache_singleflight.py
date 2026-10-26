"""Exact-key, reference-counted locks for nested read-through cache loaders.

Unrelated keys must not share a lock: striped locks can deadlock when outer
loaders acquire different stripes and their children acquire them in reverse.
Entries exist only while a caller owns or waits for that key.
"""
from contextlib import contextmanager
import threading


class KeyedLocks:
    def __init__(self):
        self._guard = threading.Lock()
        self._entries = {}

    @contextmanager
    def hold(self, key):
        with self._guard:
            entry = self._entries.get(key)
            if entry is None:
                entry = [threading.RLock(), 0]
                self._entries[key] = entry
            entry[1] += 1
        try:
            with entry[0]:
                yield
        finally:
            with self._guard:
                entry[1] -= 1
                if entry[1] == 0:
                    del self._entries[key]

    @property
    def active_keys(self):
        with self._guard:
            return len(self._entries)
