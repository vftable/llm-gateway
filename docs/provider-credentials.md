# Provider Credentials

How to obtain the extra credentials that some providers require for quota display.
These are stored in **key metadata** — open the provider in the admin panel,
click a key, and add the fields in the Metadata section.

---

## OpenCode Go

Quota display scrapes the workspace dashboard page.
Two metadata fields are required on each key:

| Field | Value |
|-------|-------|
| `workspaceId` | The workspace slug from the URL |
| `authCookie` | The value of the `auth` session cookie |

### Finding `workspaceId`

Log in to [opencode.ai](https://opencode.ai), open your workspace, and look at
the URL. It follows the pattern:

```
https://opencode.ai/workspace/<workspaceId>/go
```

Copy the `<workspaceId>` segment.

### Finding `authCookie`

1. Open your browser's DevTools (F12).
2. Go to **Application → Cookies → opencode.ai**.
3. Find the cookie named **`auth`**.
4. Copy its value (a long alphanumeric string).

The cookie expires when you log out or the session ends. If quota display stops
working, log in again and update `authCookie` with the new value.

---

## Notes

- Metadata fields are stored encrypted alongside the key credential.
- Quota data is polled every 5 minutes in the background; changes appear on
  the next poll cycle.
- If a field is wrong or expired, the Usage tab shows a specific error message
  rather than silently showing empty bars.
