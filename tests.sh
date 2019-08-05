#!/bin/bash
# commands to invoke individual function tests

# users-by-brand
sls invoke local -f users-by-brand -p brand/tests/event.json

# send-new-order-mails
sls invoke local -f send-new-order-mails -p email-notifications/tests/event.json
