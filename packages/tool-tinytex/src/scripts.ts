// The installer's two scripts, run in its own container (index.ts: the image),
// with the network, no workspace, and the tool's folder writable at $KURAA_TARGET.
// Each ends with one line on standard output: the reply prefix and JSON. What
// they print to standard error is shown to people as progress.
//
//   install.sh   downloads the pinned TinyTeX release for this machine's
//                architecture, checks its SHA-256, and unpacks it into the
//                empty folder
//   add.sh       adds LaTeX packages with tlmgr: names of packages, of files
//                (looked up with tlmgr search --global --file) and of fonts
//
// Names reach add.sh already checked (missing.ts: validPart), as one variable,
// separated by commas; they are never put into a command line unquoted.
//
// Kept as strings so they ship inside every bundle. Placeholders: @NAME@.

export const INSTALL_SH = `#!/bin/sh
set -u
reply() { printf '\\n\\037kuraa-tool\\037%s\\n' "$1"; }
fail() { echo "$1" >&2; reply "{\\"ok\\":false,\\"message\\":\\"$1\\"}"; exit 1; }
target="$KURAA_TARGET"
work="$KURAA_WORK"
arch=$(uname -m)
case "$arch" in
@CASES@
  *) fail "There is no TinyTeX for $arch computers.";;
esac
if ldd --version 2>&1 | grep -qi musl; then fail "TinyTeX for Linux needs the GNU C library, and this system has musl."; fi
cd "$work" || fail "The installer has no folder to work in."
echo "Downloading TinyTeX @VERSION@ (about @MB@ MB)…" >&2
url="https://github.com/rstudio/tinytex-releases/releases/download/v@VERSION@/$file"
curl -fL --retry 3 --connect-timeout 30 --progress-bar -o tinytex.tar.xz "$url" || fail "The download from GitHub failed. Check the connection and try again."
echo "Checking the download…" >&2
echo "$sum  tinytex.tar.xz" | sha256sum -c - >/dev/null 2>&1 || fail "The download is not the TinyTeX release expected (its checksum differs), so it was not used."
echo "Unpacking…" >&2
tar -xJf tinytex.tar.xz -C "$target" --strip-components=1 || fail "The download could not be unpacked."
rm -f tinytex.tar.xz
bin="$target/bin/$arch-linux"
[ -x "$bin/tlmgr" ] || fail "The download has no TeX programs for $arch."
export PATH="$bin:$PATH"
echo "Setting up…" >&2
# As TinyTeX's own installer does (its issue 313): fonts for xelatex.
tlmgr postaction install script xetex >&2 2>&1 || true
parts=$(tlmgr info --list --only-installed --data name 2>/dev/null | grep -E '^[A-Za-z0-9_-]+$' | sed 's/.*/"&"/' | paste -sd, -)
reply "{\\"ok\\":true,\\"arch\\":\\"$arch\\",\\"parts\\":[$parts]}"
`;

export const ADD_SH = `#!/bin/sh
set -u
reply() { printf '\\n\\037kuraa-tool\\037%s\\n' "$1"; }
fail() { echo "$1" >&2; reply "{\\"ok\\":false,\\"message\\":\\"$1\\"}"; exit 1; }
target="$KURAA_TARGET"
bin=$(ls -d "$target"/bin/*-linux 2>/dev/null | head -n 1)
[ -n "$bin" ] || fail "TinyTeX is not installed in this folder."
export PATH="$bin:$PATH"
# CTAN's TeX Live, through one mirror near by for all of this (tlmgr keeps its
# list of packages between commands for the same address). Once a newer TeX
# Live is out, the one this TinyTeX belongs to is kept, frozen, in TeX Live's
# historic archive.
repo=$(curl -fsSIL --connect-timeout 30 -o /dev/null -w '%{url_effective}' https://mirror.ctan.org/systems/texlive/tlnet/ 2>/dev/null)
case "$repo" in https://*) ;; *) repo="https://mirror.ctan.org/systems/texlive/tlnet";; esac
year=$(tlmgr --version 2>/dev/null | sed -n 's/^TeX Live .* version \\([0-9][0-9]*\\).*/\\1/p' | head -n 1)
tl() { tlmgr --repository "$repo" "$@"; }
echo "Reading TeX Live's list of packages…" >&2
# tlmgr refuses to add packages while a newer tlmgr is out: update it first.
said=$(tl update --self 2>&1)
case "$said" in
  *"is older than remote"*)
    echo "Using TeX Live $year from its archive…" >&2
    repo="https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/$year/tlnet-final"
    said=$(tl update --self 2>&1);;
esac
printf '%s\\n' "$said" | tail -n 3 >&2
packages=""
unknown=""
set -f
IFS=,
for name in $KURAA_NAMES; do
  unset IFS
  case "$name" in
    font:*)
      font=$(printf '%s' "\${name#font:}" | tr -d ' ')
      pattern="/(?i)$font(-regular)?\\.(otf|ttf)$";;
    *.*) pattern="/$name$";;
    *) packages="$packages $name"; continue;;
  esac
  echo "Looking up $name…" >&2
  found=$(tl search --global --file "$pattern" 2>/dev/null | sed -n 's/^\\([A-Za-z0-9_-][A-Za-z0-9_-]*\\):$/\\1/p' | head -n 3 | tr '\\n' ' ')
  if [ -n "$found" ]; then packages="$packages $found"; else unknown="$unknown $(printf "%s" "$name" | tr -d " ")"; fi
done
unset IFS
packages=$(printf '%s\\n' $packages | sort -u | tr '\\n' ' ')
quoted() { printf '%s\\n' $1 | grep -v '^$' | sed 's/.*/"&"/' | paste -sd, -; }
if [ -z "$(printf '%s' "$packages" | tr -d ' ')" ]; then
  reply "{\\"ok\\":false,\\"message\\":\\"TeX Live has nothing that provides$unknown.\\",\\"unknown\\":[$(quoted "$unknown")]}"
  exit 1
fi
echo "Adding$packages…" >&2
# shellcheck disable=SC2086
tl install $packages >&2 2>&1 || fail "tlmgr could not add$packages."
reply "{\\"ok\\":true,\\"added\\":[$(quoted "$packages")],\\"unknown\\":[$(quoted "$unknown")]}"
`;
