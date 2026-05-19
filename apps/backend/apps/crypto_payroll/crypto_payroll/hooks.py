app_name = "crypto_payroll"
app_title = "Crypto Payroll"
app_publisher = "ChainPay"
app_description = "Crypto-native payroll & accounting for ERPNext + Frappe HR"
app_email = "hello@chainpay.example"
app_license = "GPL-3.0-or-later"

# Document Events — wire in Phase 4
doc_events = {
    # Example shape:
    # "Crypto Payment Batch": {
    #     "on_submit": "crypto_payroll.services.payout_engine.on_batch_submit",
    # }
}

# Scheduler — wire in Phase 4
scheduler_events = {
    # "cron": {
    #     "*/5 * * * *": [
    #         "crypto_payroll.services.payout_engine.poll_pending_confirmations",
    #     ]
    # }
}

# Fixtures — none yet
fixtures = []
