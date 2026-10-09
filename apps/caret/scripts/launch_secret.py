"""One launch secret per acceptance run, and the two ways a process gets what it needs from it.

The helper and caret-screen get the secret itself on standard input (`--auth-fd 0`, B23), so the reader accepts the
helper. Caret gets only the host key, HMAC-SHA256(secret, "caret-host-key") as helper/src/host-auth.ts derives it, on an
inherited pipe whose number CARET_HOST_KEY_FD names (HostAuth.swift readInheritedKey). With it the helper admits Caret as
the host; without it Caret connects as a plain consumer and is sent no route decisions, page text or saved answers.
Neither the secret nor the key is ever on argv, in a file or in an environment value.

fill_acceptance.py and surface_acceptance.py start processes through these, so every script built on either one shares
a single secret.
"""
import hashlib
import hmac
import os
import subprocess

SECRET = os.urandom(32)
HOST_KEY_FD_VARIABLE = "CARET_HOST_KEY_FD"


def host_key(secret=SECRET):
    if len(secret) != 32:
        raise ValueError(f"a launch secret is 32 bytes, not {len(secret)}")
    return hmac.new(secret, b"caret-host-key", hashlib.sha256).digest()


def popen_with_secret(args, secret=SECRET, **popen_kwargs):
    """Popen for the helper or the reader, started with `--auth-fd 0`: the secret on standard input, which is then closed."""
    proc = subprocess.Popen(args, stdin=subprocess.PIPE, **popen_kwargs)
    proc.stdin.write(secret)
    proc.stdin.close()
    return proc


def popen_caret(args, secret=SECRET, env=None, **popen_kwargs):
    """Popen for a Caret attached to this run's helper (`--helper-socket`), with the host key on an inherited pipe.

    `env` defaults to this process's environment; CARET_HOST_KEY_FD is set in the copy the child gets. The 32 bytes fit
    the pipe's buffer, so the write end is closed before Caret starts and Caret's read sees them and then end of file.
    """
    key = host_key(secret)
    r, w = os.pipe()
    try:
        try:
            wrote = os.write(w, key)
        finally:
            os.close(w)
        if wrote != len(key):
            raise OSError(f"wrote {wrote} of {len(key)} host key bytes to the pipe")
        child_env = dict(os.environ if env is None else env)
        child_env[HOST_KEY_FD_VARIABLE] = str(r)
        # pass_fds keeps the descriptor's number in the child, which is what the variable names.
        return subprocess.Popen(args, env=child_env, pass_fds=(r,), **popen_kwargs)
    finally:
        os.close(r)
