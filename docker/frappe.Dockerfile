# Phase 4 — base image for Frappe bench + crypto_payroll custom app.
# Placeholder; real Dockerfile arrives with Phase 4 wire-up.

FROM frappe/bench:latest

USER frappe
WORKDIR /workspace

# crypto_payroll source bind-mounted via docker-compose volumes
# Bench init / app install happens via README-documented commands, not at build time
# (lets the same image serve both `bench new-site` and ongoing development).

EXPOSE 8000 9000
CMD ["bash"]
