import { ConfigList, ConfigOption } from '@site/src/components/ConfigOption';

# End of Life (EOL)

WUD can show whether the version a container is running is still supported. An available update does **not** mean the running version is end of life: `postgres:16` gets updates and is supported until 2028. The other way round, a patch update may stay in a release cycle that is already EOL.

The EOL status is shown as a red `EOL` or orange `EOL soon` badge next to the current version on the Containers page, in the container details (**Support**) and in the API (`eol` property). The **EOL** switch on the Containers page lists only those containers.

WUD looks for an EOL source in this order:

1. The `wud.eol.product` label: an [endoflife.date](https://endoflife.date) product, chosen by you.
2. The `wud.eol.policy` label: a rule based on the newer versions WUD finds in the registry.
3. Automatic matching of the image on endoflife.date (about 150 Docker images such as `postgres`, `traefik`, `node`, `redis`, `bitnami/*`).

Without a source the status is unknown and nothing is shown. Many self-hosted apps (Pi-hole, Home Assistant, …) have no EOL policy at all.

## endoflife.date lookup

The lookup is **disabled by default**. When enabled, WUD downloads the endoflife.date image mapping and the release data of the products in use, keeps them in memory and refreshes them on a schedule. Only product names are sent to endoflife.date, never image names or hosts.

<ConfigList>
  <ConfigOption name="WUD_EOL_ENABLED" required={false} type="boolean" defaultValue="false">
    Enable the endoflife.date lookup (policy labels work without it)
  </ConfigOption>
  <ConfigOption name="WUD_EOL_CRON" required={false} type="string" defaultValue="0 4 * * *">
    CRON schedule to refresh endoflife.date data
  </ConfigOption>
  <ConfigOption name="WUD_EOL_WARNDAYS" required={false} type="number" defaultValue="90">
    Show `EOL soon` when the end of life is less than this number of days away
  </ConfigOption>
  <ConfigOption name="WUD_EOL_URL" required={false} type="string" defaultValue="https://endoflife.date">
    endoflife.date base URL (e.g. a mirror)
  </ConfigOption>
</ConfigList>

The release cycle is the longest cycle name matching the running version (`3.6.2` → `3.6`, `16.4` → `16`). Tags that are not semver (e.g. `latest`) use the image's `org.opencontainers.image.version` label.

## Labels

<ConfigList>
  <ConfigOption name="eol.product" required={false} type="string" supported="Any endoflife.date product (e.g. postgresql), or none">
    endoflife.date product of the image (overrides automatic matching). `none` disables the EOL status
  </ConfigOption>
  <ConfigOption name="eol.cycle" required={false} type="string" supported="Release cycle name (e.g. 16)">
    Release cycle to use instead of matching the running version (with `eol.product`)
  </ConfigOption>
  <ConfigOption name="eol.policy" required={false} type="string" supported="latest-major, latest-minor, latest-n-major:<n>, latest-n-minor:<n>">
    Support rule based on newer release lines found in the registry (semver tags only)
  </ConfigOption>
</ConfigList>

### Policies

A policy counts the newer **release lines** WUD found in the registry: a major line is e.g. `18`, a minor line is e.g. `2.14`.

| Policy | Supported | Example |
| :--- | :--- | :--- |
| `latest-major` | the newest major line only | running `17.2`, `18.0` exists → EOL |
| `latest-minor` | the newest minor line only | running `2.13.1`, `2.14.0` exists → EOL |
| `latest-n-major:<n>` | the newest `n` major lines | `latest-n-major:3` with `18.1`: 18, 17 and 16 supported, `15.1` EOL |
| `latest-n-minor:<n>` | the newest `n` minor lines | `latest-n-minor:2` with `2.14`: 2.14 and 2.13 supported, `2.12` EOL |

Lines are counted from the tags matching the container's tag filters (`tag.include`, `tag.exclude`, `tag.transform`). Policies give no EOL date, so there is no `EOL soon` status.

```yaml title="docker-compose.yml"
services:
  external-secrets:
    # Only the latest minor version is supported upstream
    image: ghcr.io/external-secrets/external-secrets:v2.13.1
    labels:
      - wud.eol.policy=latest-minor

  db:
    image: postgres:15.1
    labels:
      - wud.eol.policy=latest-n-major:3

  custom-db:
    # Derived image: use PostgreSQL release data
    image: myorg/postgres:16.4
    labels:
      - wud.eol.product=postgresql
```

Kubernetes, Swarm and Nomad use the same keys with their usual prefixes (e.g. `getwud.app/eol.policy`).
