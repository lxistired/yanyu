"""Linux inherited-writer contract. Validate before imports, reads or writes.
Never unlock: the kernel releases ownership after the final inherited fd closes.
Only trusted launchers that preserve these descriptors are supported.
"""
import os
import stat
import sys


def validated_fds():
    if sys.platform != 'linux':
        raise RuntimeError('Worker fence unavailable')
    descriptors = []
    for name, expected in (('OWNER', 3), ('LEASE', 4)):
        if os.environ.get('YANYU_' + name + '_FD') != str(expected):
            raise RuntimeError('Worker fence unavailable')
        st = os.fstat(expected)
        identity = str(st.st_dev) + ':' + str(st.st_ino)
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or identity != os.environ.get('YANYU_' + name + '_ID'):
            raise RuntimeError('Worker fence unavailable')
        with open('/proc/self/fdinfo/' + str(expected)) as info:
            if not any(line.startswith('lock:') and 'FLOCK' in line and 'ADVISORY' in line and 'WRITE' in line for line in info):
                raise RuntimeError('Worker fence unavailable')
        descriptors.append(expected)
    return tuple(descriptors)


def watch_owner():
    # EOF also catches parent death before this watcher starts. The fence,
    # not this liveness aid, prevents recovery while descendants survive.
    import threading
    if os.environ.get('YANYU_LIVENESS_FD') != '5' or not stat.S_ISSOCK(os.fstat(5).st_mode):
        raise RuntimeError('Worker owner channel unavailable')
    def watch():
        try:
            while os.read(5, 1):
                pass
        finally:
            os._exit(2)
    threading.Thread(target=watch, daemon=True).start()
