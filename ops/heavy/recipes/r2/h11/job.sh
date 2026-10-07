#!/bin/bash
# rig-timeout-seconds: 3500
# H11 (from Q2/H10): page tasks in the real app. One boot of a throwaway rig clone: the acceptance Caret.app with live
# Jev (no Groq), TextEdit holding the person's note, Chrome for Testing with Caret's extension on the repo's task pages
# (served with their oracle by fixture/h11_site.ts), driven by real HID keys (allowed only in the rig VM) and scored
# from read-backs Caret doesn't own (q2.py page_task).
#
# The model keys arrive at run time: run.sh on the host writes them over ssh stdin into secret.fifo, which this job
# reads once, removes, and acknowledges with keys.ok. They then live in this shell's unexported variables and in one
# file on a RAM volume this job made and verified, with Spotlight off before the write (CARET_ENV_FILE: the host
# forwards only that and TYPESAFE_API_KEY to its helper, and Groq has no other path). At the end, or on TERM/INT,
# finish() stops every writer, erases the RAM disk and scans out/ (leakscan.py) before rig-run copies it back; a hit
# deletes the file and fails the run (exit 99). leak-check.txt says CLEAN only after a complete scan.
set -u
set +x
unset K_JEV K_GROQ SECRETS TYPESAFE_API_KEY GROQ_API_KEY
P="$RIG_PAYLOAD"; O="$RIG_OUT"; T="$P/tools"
# One deadline for everything, keeping 200 s for teardown and the scan under rig-run's 3500 s.
DEADLINE=3300
say() { echo "$(date +%T) +${SECONDS}s $*" | tee -a "$O/job.log"; }
say "rev $(cat "$P/REV") front $(lsappinfo info -only name "$(lsappinfo front)" | sed 's/.*=//')"

K_JEV=""; K_GROQ=""; RAMDEV=""; ENVF=""; M=""; DONE=""
stop_pid_tree() {
  local p=$1 child
  for child in $(pgrep -P "$p" 2>/dev/null); do stop_pid_tree "$child"; done
  echo "$p" >> "$O/stopped-pids.txt"
  kill -TERM "$p" 2>/dev/null || true
}
finish() {
  [ -n "$DONE" ] && return 0; DONE=1
  # Stop only exact guest pids. Bootout prevents launchd restarting the owned host.
  touch "$O/.done"
  launchctl bootout "gui/$(id -u)/dev.caret.host" 2>/dev/null
  local pat pid
  for pat in "acc/Caret.app/Contents/" "Google Chrome for Testing" "TextEdit.app/Contents/MacOS/TextEdit" "$T/q2.py" "$T/h14.py" "$T/h14-key serve" "$P/fixture/h11_site.ts" "http.server 8790"; do
    for pid in $(pgrep -f "$pat" 2>/dev/null); do
      [ "$pid" != "$$" ] && stop_pid_tree "$pid"
    done
  done
  [ -n "${WATCH_PID:-}" ] && stop_pid_tree "$WATCH_PID"
  sleep 2
  if [ -f "$O/stopped-pids.txt" ]; then
    while read -r pid; do kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null; done < "$O/stopped-pids.txt"
  fi
  sleep 1
  mkdir -p "$O/jev-spend"
  if [ -d "$HOME/Library/Application Support/CaretV2/jev-spend" ]; then
    cp "$HOME/Library/Application Support/CaretV2/jev-spend/"*.ndjson "$O/jev-spend/" 2>/dev/null || true
  fi
  ps -axo pid=,ppid=,comm= > "$O/guest-processes-after.txt"
  if [ -n "$RAMDEV" ]; then
    [ -n "$ENVF" ] && { rm -P "$ENVF" 2>/dev/null; rm -f "$ENVF"; }
    diskutil eject "$RAMDEV" >> "$O/ramdisk.txt" 2>&1 || hdiutil detach -force "$RAMDEV" >> "$O/ramdisk.txt" 2>&1
    say "RAM disk ejected: $(diskutil list | grep -c "q2ram$$") q2ram volumes left"
  fi
  touch "$O/.done"
  if [ -z "$K_JEV$K_GROQ" ]; then echo "NO KEYS (nothing to scan for)" > "$O/leak-check.txt"; return 0; fi
  local scan src leaks
  scan=$({ [ -n "$K_JEV" ] && printf '%s\n' "$K_JEV"; [ -n "$K_GROQ" ] && printf '%s\n' "$K_GROQ"; } | "$RIG_PYTHON" "$T/leakscan.py" "$O"); src=$?
  K_JEV=""; K_GROQ=""
  leaks=$(printf '%s\n' "$scan" | sed '1d' | grep .)
  if [ $src != 0 ]; then echo "FAILED (scanner exit $src)" > "$O/leak-check.txt"; say "leak check could not finish"; return 98; fi
  if [ -n "$leaks" ]; then
    printf '%s\n' "$leaks" | while read -r f; do rm -rf "$f"; done
    echo "A model key (or 16 characters of one) was found in $(printf '%s\n' "$leaks" | wc -l | tr -d ' ') file(s) in the guest; they were deleted before copy-back." > "$O/KEY-LEAK.txt"
    echo "LEAK" > "$O/leak-check.txt"; say "KEY LEAK; files deleted"; return 99
  fi
  echo "CLEAN $(printf '%s\n' "$scan" | head -1)" > "$O/leak-check.txt"; say "leak check: clean ($(printf '%s\n' "$scan" | head -1))"
  return 0
}
trap 'finish; exit 143' TERM
trap 'finish; exit 130' INT

# Nonsecret controls are staged by the R2 coordinator just before this lease.
# Seed the guest ledger with the host's total so host-total + remaining is also a guest-side limit.
export CARET_JEV_DAILY_CAP=$("$RIG_PYTHON" -c 'import json,sys; print(json.load(open(sys.argv[1]))["capUsd"])' "$P/spend-control.json")
"$RIG_PYTHON" - "$P/spend-control.json" "$O" <<'PY'
import datetime,json,os,sys
from pathlib import Path
c=json.load(open(sys.argv[1]))
d=Path.home()/'Library/Application Support/CaretV2/jev-spend'
d.mkdir(parents=True,exist_ok=True)
day=datetime.date.today()
# Block requests after local midnight so a day rollover cannot renew this run allowance.
for dt in (day,day+datetime.timedelta(days=1)):
    p=d/f'{dt}.ndjson'
    if p.exists() and p.stat().st_size:
        raise SystemExit('Guest has an existing spend ledger; refusing an unaccounted run')
    p.write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'usd':c['seedUsd'] if dt==day else c['capUsd'],'tokens':0,'pid':os.getpid(),'r2Seed':True})+'\n')
(Path(sys.argv[2])/'spend-control.json').write_text(json.dumps(c,indent=2)+'\n')
PY
[ $? = 0 ] || { say "spend seed failed"; exit 64; }

# The guest's resolver, the host's vmnet forwarder at 192.168.64.1, answered nothing in Q2's first e0e49e1 run while IP
# egress worked (curl by IP reached both model APIs; dig @1.1.1.1 resolved), so every model call failed. Point this
# clone's network service at public resolvers and check both API names resolve before going on.
svc=$(networksetup -listallnetworkservices | sed -n '2,$p' | grep -v '^\*' | head -1)
echo lume | sudo -S -p "" networksetup -setdnsservers "$svc" 1.1.1.1 8.8.8.8 >> "$O/dns.txt" 2>&1
dscacheutil -flushcache
for h in api.typesafe.ai; do
  ip=""; for i in 1 2 3 4 5; do ip=$(dscacheutil -q host -a name "$h" | sed -n 's/^ip_address: //p' | head -1); [ -n "$ip" ] && break; sleep 2; done
  say "dns ($svc -> 1.1.1.1, 8.8.8.8): $h -> ${ip:-UNRESOLVED}"
done

# ------------------------------------------------------------------------------------------------- the keys
FIFO="$RIG_JOB/secret.fifo"
rm -f "$FIFO" "$RIG_JOB/keys.ok"; mkfifo -m 600 "$FIFO"
say "waiting up to 240 s for the keys on $FIFO"
SECRETS=$(perl -e 'alarm 240; open(my $f, "<", $ARGV[0]) or die "open: $!"; local $/; print <$f>' "$FIFO" 2>/dev/null)
rm -f "$FIFO"
K_JEV=$(printf '%s\n' "$SECRETS" | sed -n 's/^TYPESAFE_API_KEY=//p')
K_GROQ=$(printf '%s\n' "$SECRETS" | sed -n 's/^GROQ_API_KEY=//p')
SECRETS=""
[ -n "$K_JEV" ] && touch "$RIG_JOB/keys.ok"
say "keys: jev $([ -n "$K_JEV" ] && echo yes || echo NO), groq $([ -n "$K_GROQ" ] && echo yes || echo NO)"

# The env file goes only on a RAM volume this job made and verified, with Spotlight off before any key is written.
ramdisk() {
  RAMDEV=$(hdiutil attach -nomount ram://16384 2>>"$O/ramdisk.txt" | awk 'NR==1{print $1}')
  [[ "$RAMDEV" =~ ^/dev/disk[0-9]+$ ]] || { say "RAM disk: attach failed"; RAMDEV=""; return 1; }
  diskutil erasevolume HFS+ "q2ram$$" "$RAMDEV" >> "$O/ramdisk.txt" 2>&1 || { say "RAM disk: erase failed"; return 1; }
  M=$(diskutil info "$RAMDEV" | sed -n 's/^ *Mount Point: *//p')
  [ -n "$M" ] && [ -d "$M" ] || { say "RAM disk: no mount point"; return 1; }
  [ "$(df "$M" | awk 'NR==2{print $1}' | sed -E 's/s[0-9]+$//')" = "$RAMDEV" ] || { say "RAM disk: $M is not on $RAMDEV"; return 1; }
  touch "$M/.metadata_never_index" || return 1
  echo lume | sudo -S -p "" mdutil -i off "$M" >> "$O/ramdisk.txt" 2>&1 || { say "RAM disk: mdutil -i off failed"; return 1; }
  ENVF="$M/caret.env"
  ( umask 077; { printf 'TYPESAFE_API_KEY=%s\n' "$K_JEV"; [ -n "$K_GROQ" ] && printf 'GROQ_API_KEY=%s\n' "$K_GROQ"; } > "$ENVF" )
  say "env file on RAM disk $RAMDEV ($(stat -f %Sp "$ENVF"))"
}
if [ -n "$K_JEV" ] && ! ramdisk; then ENVF=""; say "no verified RAM disk: the run goes on without live models"; fi

# ------------------------------------------------------------------------------------------------- the run
Q2_ENV_FILE="$ENVF" Q2_PREVIEW="${Q2_PREVIEW:-0}" Q2_BUDGET=$(( DEADLINE - SECONDS - 60 )) \
  perl -e "alarm $(( DEADLINE - SECONDS )); exec @ARGV" "$RIG_PYTHON" "$T/q2.py" "$O" > "$O/q2.stdout.log" 2>&1
say "q2.py exit $?"

finish; frc=$?
[ $frc = 0 ] || exit $frc
[ -f "$O/results.json" ]
