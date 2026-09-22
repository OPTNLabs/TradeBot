#!/usr/bin/env bash
# pre-commit-key-scan.sh
#
# Blocks any commit that contains a private key, seed phrase, mnemonic, or WIF
# pattern. Designed to be installed as the project's pre-commit hook:
#
#   bash scripts/pre-commit-key-scan.sh --install
#   # (or)  git config core.hooksPath scripts/git-hooks
#
# or run manually:
#
#   bash scripts/pre-commit-key-scan.sh
#
# No keys are ever stored in this repo — see SECURITY.md.
#
# Performance note (D1.8, 2026-07-22):
#   The BIP39 phrase scan used to call `grep -qx <word> <wordlist>` once per
#   token, spawning one process per word. For a 6-file diff of medium docs
#   that was ~45k process spawns / ~minutes of wall time. It now builds a
#   single alternation regex from the wordlist and runs ONE awk pass per
#   staged blob — O(N) total work, sub-second for realistic diffs.

set -euo pipefail

if [ "${1:-}" = "--install" ]; then
  mkdir -p scripts/git-hooks
  cp -f scripts/pre-commit-key-scan.sh scripts/git-hooks/pre-commit
  chmod +x scripts/git-hooks/pre-commit
  echo "Installed: scripts/git-hooks/pre-commit"
  echo "Wire it in:  git config core.hooksPath scripts/git-hooks"
  exit 0
fi

# Collect staged content (added/modified/copied/renamed) but skip deletions.
mapfile -t STAGED < <(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null || true)
if [ "${#STAGED[@]}" -eq 0 ]; then
  exit 0
fi

FAIL=0

echo "pre-commit-key-scan: scanning ${#STAGED[@]} staged file(s) for key-like content..."

# 1. Hard block common key-file extensions at the path level.
for path in "${STAGED[@]}"; do
  base=$(basename "$path")
  case "$base" in
    *.wif|*.wif.txt|*.seed|*.mnemonic|*.key|*.pem|*.p12|wallet.json|*_wallet.json)
      echo "BLOCKED: staged file '$path' has a key-like extension." >&2
      echo "  See SECURITY.md — no keys, seeds, mnemonics, or WIFs are ever committed." >&2
      FAIL=1
      ;;
  esac
  case "$path" in
    *_wallet/*|*_test_wallet/*|.keystore/*|secrets/*|*/passwords/*)
      echo "BLOCKED: staged file '$path' is inside a wallet/secret path." >&2
      echo "  See SECURITY.md — wallet artifacts belong in the project that uses them, not here." >&2
      FAIL=1
      ;;
  esac
done

# 2. WIF pattern (base58check, mainnet starts with 5/K/L; testnet with 9/c).
#    51–52 base58 chars.
WIF_RE='\b[5KL9c][1-9A-HJ-NP-Za-km-z]{50,51}\b'

# 3. 64-char hex inside a key-like filename.
HEX64_RE='\b[a-fA-F0-9]{64}\b'

# 4. BIP39 phrase detection: 12+ consecutive words from a small common-word subset.
#
# Approach: build a single alternation regex `(word1|word2|...|word256)`
# from the wordlist, then run ONE awk invocation per staged blob that
# tokenises the input, lowercases each token, tests membership with the
# regex, and tracks the consecutive-match count. Exits non-zero when a
# 12-consecutive-word run is detected — bash turns that into $?≠0 and
# the caller flips FAIL=1.
#
# Consecutive matches reset at any non-word boundary (and across newlines,
# matching the previous per-line behaviour).
COMMON_BIP39_FILE="$(mktemp)"
trap 'rm -f "$COMMON_BIP39_FILE"' EXIT

# A sample of ~256 common BIP39 words (subset of the full 2048-word list).
# This is a heuristic — false positives are OK, false negatives are bad.
cat > "$COMMON_BIP39_FILE" <<'WORDS'
abandon
ability
able
about
above
absent
absorb
abstract
absurd
abuse
access
accident
account
accuse
achieve
acid
acoustic
acquire
across
act
action
actor
actress
actual
adapt
add
addict
address
adjust
admit
adult
advance
advice
aerobic
affair
afford
afraid
again
age
agent
agree
ahead
aim
air
airport
aisle
alarm
album
alcohol
alert
alien
all
alley
allow
almost
alone
alpha
already
also
alter
always
amateur
amazing
among
amount
amused
analyst
anchor
ancient
anger
angle
angry
animal
ankle
announce
annual
another
answer
antenna
antique
anxiety
any
apart
apology
appear
apple
approve
april
arch
arctic
area
arena
argue
arm
armed
armor
army
around
arrange
arrest
arrive
arrow
art
artist
ask
aspect
assault
asset
assist
assume
attack
attend
auction
audit
august
aunt
author
auto
autumn
average
avocado
avoid
awake
aware
away
awesome
awful
awkward
axis
baby
bachelor
bacon
badge
bag
balance
balcony
ball
bamboo
banana
banner
bar
barely
bargain
barrel
base
basic
basket
battle
beach
bean
beauty
because
become
beef
before
begin
behave
behind
believe
below
belt
bench
benefit
best
betray
better
between
beyond
bicycle
bid
bike
bind
biology
bird
birth
bitter
black
blade
blame
blanket
blast
bleak
bless
blind
blood
blossom
blouse
blue
blur
blush
board
boat
body
boil
bomb
bone
bonus
book
boost
border
boring
borrow
boss
bottom
bounce
box
boy
bracket
brain
brand
brass
brave
bread
breeze
brick
bridge
brief
bright
bring
brisk
broccoli
broken
bronze
broom
brother
brown
brush
bubble
buddy
budget
buffalo
build
bulb
bulk
bullet
bundle
bunker
burden
burger
burst
bus
business
busy
butter
buyer
buzz
WORDS

# Build a single alternation regex: (word1|word2|...|wordN).
# None of the BIP39 words contain `|`, so the simple join is safe.
BIP39_ALT="$(tr '\n' '|' < "$COMMON_BIP39_FILE" | sed 's/|$//')"

# check_blob_for_phrase <blob> <path> — exit 0 if clean, 1 if a 12-consecutive
# BIP39 phrase was detected in the blob.
#
# Note: the awk program uses `\047` (octal 0x27 = apostrophe) to embed the
# file path on the stderr `print` lines. Standard awk doesn't have a
# portable way to escape single quotes inside a -v-passed shell string,
# so the octal escape is the cleanest portable workaround.
check_blob_for_phrase() {
  local blob="$1"
  local path="$2"
  awk -v re="$BIP39_ALT" -v p="$path" '
    BEGIN { IGNORECASE = 1 }
    {
      count = 0
      n = split($0, arr, /[^[:alpha:]]+/)
      for (i = 1; i <= n; i++) {
        lc = tolower(arr[i])
        if (lc == "") continue
        # Anchored alternation match = exact word membership in the list.
        if ((lc ~ ("^(" re ")$"))) {
          count++
          if (count >= 12) {
            print "BLOCKED: \047" p "\047 contains a string of 12+ BIP39-list words on one line." > "/dev/stderr"
            print "  This pattern matches seed phrases. If this is a false positive (e.g. a list of words)," > "/dev/stderr"
            print "  split the list so no 12 consecutive words appear on a single line." > "/dev/stderr"
            exit 1
          }
        } else {
          count = 0
        }
      }
    }
    # NB: no END { exit 0 } — when the rule-level `exit 1` triggers a 12-word
    # run, an END-block `exit 0` would override it and the hook would silently
    # pass the file. Default awl behavior (no exit specified, END runs to
    # completion) leaves the rule-level exit code intact.
  ' <<< "$blob"
}

for path in "${STAGED[@]}"; do
  # Skip this script itself (it intentionally contains the patterns + wordlist).
  case "$path" in
    scripts/pre-commit-key-scan.sh|scripts/git-hooks/pre-commit|SECURITY.md|PLAN.md|README.md)
      continue
      ;;
  esac
  # Only scan text-ish files.
  if git diff --cached --numstat -- "$path" 2>/dev/null | awk '{print $1}' | grep -q '^-$'; then
    continue
  fi

  blob=$(git show ":$path" 2>/dev/null || true)
  [ -z "$blob" ] && continue

  if echo "$blob" | grep -qE "$WIF_RE"; then
    echo "BLOCKED: '$path' contains a string matching a WIF pattern." >&2
    echo "  Match: $(echo "$blob" | grep -oE "$WIF_RE" | head -1)" >&2
    FAIL=1
  fi

  case "$path" in
    *key*|*seed*|*wallet*|*mnemonic*|*wif*|*password*|*secret*|*credential*|*backup*)
      if echo "$blob" | grep -qE "$HEX64_RE"; then
        echo "BLOCKED: '$path' (key-like filename) contains a 64-char hex string." >&2
        FAIL=1
      fi
      ;;
  esac

  if ! check_blob_for_phrase "$blob" "$path"; then
    FAIL=1
  fi
done

if [ "$FAIL" -ne 0 ]; then
  echo "" >&2
  echo "pre-commit-key-scan: commit REJECTED. Remove the offending content and retry." >&2
  echo "  See SECURITY.md for the no-keys-in-repo policy." >&2
  exit 1
fi

echo "pre-commit-key-scan: OK (${#STAGED[@]} file(s) scanned, no matches)"
exit 0
