# Supervised operator processes

Six processes, six units, five separate keys and one process that holds none.
Two of those keys belong to two independent resolver processes: one resolver
can attest, but it can never form the contract's two-signer quorum by itself.

The separation is not deployment tidiness. The gate signs Publication Permits,
the publisher sends the transaction those permits authorise, the resolvers
attest results, and the Coordinator holds no chain key at all. Putting two
authorities in one process, or one key in two, collapses the separation every
guarantee in this system rests on. That is why each unit starts exactly one
role and reads exactly one environment file.

Install:

```bash
sudo cp tradermarket-*.service /etc/systemd/system/
sudo install -d -m 0750 -o tradermarket -g tradermarket /etc/tradermarket
# one file per role, mode 0400, owned by the service user
sudo systemctl daemon-reload
sudo systemctl enable --now tradermarket-api tradermarket-gate \
  tradermarket-publisher tradermarket-connector tradermarket-resolver \
  tradermarket-resolver-2
```

Each `/etc/tradermarket/<role>.env` carries that role's configuration and its
own signing key. The resolvers use `resolver.env` and `resolver-2.env`, with
different `TM_RESOLVER_KEY` values that match two members of the room's frozen
resolver set. Keys never appear in a unit file, in this repository, or in a
process's command line — `TM_*_KEY` in an `ExecStart` line would be visible to
every user on the machine through `/proc`.

**This is not a claim that a deployment exists.** These units are what a
deployment would need; nothing here has been run against a public network, and
no key in any example is real.
