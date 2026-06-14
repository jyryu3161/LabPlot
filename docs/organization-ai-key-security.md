# Organization AI Key Security

LabPlot supports organization-scoped LLM API keys for lab or institution use.

## Implemented Controls

- Organization admins enter provider keys through write-only fields.
- API responses only return key presence metadata (`has_anthropic_key`, `has_gemini_key`) and never return plaintext keys.
- Audit logs redact key-shaped fields before persistence.
- AI usage rows record `organization_id` so organization admins can review monthly request, token, and estimated cost totals.
- Active organization members use their organization's key first; if no active organization key is configured, LabPlot falls back to the platform-level AI config.
- Stored organization keys are encrypted before database persistence.

## Secret Storage Modes

### Local mode

`SECRET_ENCRYPTION_PROVIDER=local` uses the application `DATA_ENCRYPTION_KEY` through LabPlot's existing encrypted private-byte format. This protects against database-only compromise and accidental DB backup exposure.

It does not fully protect against a server operator who can read application environment variables, process memory, or run code as the application user.

### AWS KMS mode

`SECRET_ENCRYPTION_PROVIDER=aws_kms` stores ciphertext produced by AWS KMS:

```env
SECRET_ENCRYPTION_PROVIDER=aws_kms
SECRET_AWS_KMS_KEY_ID=arn:aws:kms:...
SECRET_AWS_KMS_REGION=us-east-1
```

For stronger operator separation:

- Grant `kms:Decrypt` only to the runtime identity used by the backend service.
- Do not grant `kms:Decrypt` to DB admins, deployment operators, or regular cloud users.
- Separate KMS key administration from application operation.
- Enable KMS audit logging and review decrypt activity.
- Rotate provider API keys from the provider dashboard and update the organization key in LabPlot.

Even with KMS, a fully privileged host/root operator can potentially observe plaintext while the backend is using it. Stronger guarantees require moving key use to a separate secret broker, HSM-backed service, or customer-controlled gateway that the LabPlot host cannot introspect.

## References

- OWASP Secrets Management Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html
- AWS KMS envelope encryption concepts: https://docs.aws.amazon.com/kms/latest/developerguide/kms-cryptography.html
- AWS Secrets Manager KMS encryption: https://docs.aws.amazon.com/secretsmanager/latest/userguide/security-encryption.html
- Google Cloud KMS envelope encryption guidance: https://docs.cloud.google.com/kms/docs/envelope-encryption
- NIST SP 800-57 key management guidance: https://csrc.nist.gov/pubs/sp/800/57/pt1/r5/final
