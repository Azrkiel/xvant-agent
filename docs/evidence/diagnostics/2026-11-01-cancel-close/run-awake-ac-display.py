import ctypes
from ctypes import wintypes
import os
import subprocess
import sys

if len(sys.argv) < 2:
    raise SystemExit('Usage: run-awake.py COMMAND [ARG ...]')
if os.name != 'nt':
    raise SystemExit('This qualification wrapper requires Windows.')

class PowerStatus(ctypes.Structure):
    _fields_ = [
        ('ACLineStatus', ctypes.c_ubyte), ('BatteryFlag', ctypes.c_ubyte),
        ('BatteryLifePercent', ctypes.c_ubyte), ('SystemStatusFlag', ctypes.c_ubyte),
        ('BatteryLifeTime', wintypes.DWORD), ('BatteryFullLifeTime', wintypes.DWORD),
    ]

kernel = ctypes.WinDLL('kernel32', use_last_error=True)
get_power = kernel.GetSystemPowerStatus
get_power.argtypes = [ctypes.POINTER(PowerStatus)]
get_power.restype = wintypes.BOOL
power = PowerStatus()
if not get_power(ctypes.byref(power)) or power.ACLineStatus != 1:
    raise SystemExit('Qualification blocked: connect AC power first.')

set_state = kernel.SetThreadExecutionState
set_state.argtypes = [wintypes.DWORD]
set_state.restype = wintypes.DWORD
# Explicit operator-approved temporary display and system request. No policy edits.
previous = set_state(0x80000003)
if not previous:
    raise SystemExit('Qualification blocked: native awake request refused.')
print('AC verified; scoped system + display awake request accepted. Keep lid open.', flush=True)
argv = sys.argv[1:]
if argv[0] == 'npm':
    argv = [r'C:\Users\jiang\XVANT\.tools\node_modules\node-win-x64\bin\node.exe',
            r'C:\Users\jiang\XVANT\.tools\node_modules\npm\bin\npm-cli.js', *argv[1:]]
restore_failed = False
try:
    code = subprocess.run(argv).returncode
finally:
    restore_failed = not bool(set_state(previous))
    print('Scoped awake state restored.' if not restore_failed else
          'ERROR: native awake-state restoration refused.', flush=True)
if restore_failed:
    raise SystemExit(125)
raise SystemExit(code)
