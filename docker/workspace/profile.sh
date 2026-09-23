# /etc/profile.d/vibe.sh — Debian's /etc/profile resets PATH for login shells,
# so re-prepend the user tool volume (npm/pnpm/bun/uv globals installed from
# inside the workspace land there and must win over the image's versions).
case ":${PATH}:" in
  *:/opt/vibe-tools/bin:*) ;;
  *) PATH="/opt/vibe-tools/bin:/opt/vibe-tools/pnpm:/opt/vibe-tools/bun/bin:${PATH}" ;;
esac
export PATH
