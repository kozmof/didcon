"""Validate the policy before opening any listener, then start the fixed proxy."""
import os

# Import errors and invalid allowlists must terminate the process. Do not rely
# on an interactive proxy's addon-error handling to fail closed.
from addon import addons

assert addons
os.execvp('mitmdump', ['mitmdump', '-q', '--mode', 'regular', '--listen-port', '443', '-s', '/policy/addon.py',
                     '--set', 'confdir=/pki', '--set', 'connection_strategy=lazy', '--set', 'upstream_cert=false',
                     '--set', 'ssl_insecure=false', '--set', 'rawtcp=false'])
