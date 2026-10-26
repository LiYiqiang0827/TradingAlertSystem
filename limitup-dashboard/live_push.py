"""One Redis blocking reader broadcasts completed batches to bounded SSE subscribers."""
from __future__ import annotations
import json, queue, threading, time, uuid

class LivePushHub:
    def __init__(self, build_event, redis_url='redis://127.0.0.1:6380/0'):
        self.build_event=build_event; self.redis_url=redis_url
        self.lock=threading.RLock(); self.subscribers={}; self.thread=None
        self.epoch=uuid.uuid4().hex[:10]; self.sequence=0; self.last_id=None
        self.events=0; self.last_event_at=None; self.last_error=None; self.connected=False

    def start(self):
        with self.lock:
            if self.thread is None:
                self.thread=threading.Thread(target=self._run,name='redis-live-push',daemon=True)
                self.thread.start()

    def subscribe(self):
        mailbox=queue.Queue(maxsize=16); token=uuid.uuid4().hex
        with self.lock: self.subscribers[token]=mailbox
        self.start(); return token,mailbox

    def unsubscribe(self,token):
        with self.lock: self.subscribers.pop(token,None)

    def status(self):
        with self.lock:
            return {'transport':'sse','reader':'redis-xread-block','connected':self.connected,
                    'subscribers':len(self.subscribers),'events':self.events,'lastEventAt':self.last_event_at,
                    'lastStreamId':self.last_id,'lastError':self.last_error,'epoch':self.epoch}

    def _broadcast(self,event):
        with self.lock:
            self.sequence+=1; event={**event,'id':f'{self.epoch}:{self.sequence}'}
            self.events+=1; self.last_event_at=time.time()
            for mailbox in self.subscribers.values():
                if mailbox.full():
                    while not mailbox.empty():
                        try:mailbox.get_nowait()
                        except queue.Empty:break
                    message={**event,'resync':True}
                else:message=event
                try:mailbox.put_nowait(message)
                except queue.Full:pass

    def _run(self):
        import redis
        cursor=None
        while True:
            try:
                client=redis.Redis.from_url(self.redis_url,decode_responses=True,
                    socket_connect_timeout=2,socket_timeout=20,health_check_interval=15)
                if cursor is None:
                    last=client.xrevrange('online:events',count=1)
                    cursor=last[0][0] if last else '0-0'
                with self.lock:self.connected=True;self.last_error=None
                while True:
                    batches=client.xread({'online:events':cursor},count=64,block=15000)
                    for _,entries in batches:
                        # Coalesce accumulated notifications by kind; source archives are complete.
                        updates={}
                        for stream_id,fields in entries:
                            cursor=stream_id;self.last_id=stream_id
                            item=json.loads(fields['payload']);updates[item['kind']]=item
                        if updates:
                            event=self.build_event(list(updates.values()))
                            self._broadcast(event)
            except Exception as exc:
                with self.lock:self.connected=False;self.last_error=f'{type(exc).__name__}: {exc}'
                self._broadcast({'resync':True,'error':'Redis update stream temporarily unavailable','updates':[]})
                time.sleep(3)
