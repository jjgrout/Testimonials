# Testimonials

Private AWS serverless application for generating Australian Defence Force exit/service testimonials
from documents stored under:

```text
s3://jta-data-bucket/JTA data set/
```

The app is designed for controlled AWS environments with no internet egress from runtime
compute. Users connect through a VPN/private network path into the VPC, authenticate with a
username/password stored in AWS Secrets Manager, search S3 object titles for a person
identifier, select source files, generate a 250-350 word testimonial with Amazon Bedrock
Claude 3.5 Sonnet, edit the generated text, and export a formatted PDF. Printed and
handwritten OCR for supported image/scanned files is provided by Amazon Textract.

## Architecture

- **AWS CDK v2 / TypeScript** infrastructure.
- **Private API Gateway REST API** serving both the frontend and backend API.
- **AWS Lambda in private isolated subnets** with no NAT gateway and no internet route.
- **VPC endpoints** for:
  - S3 gateway access
  - API Gateway private access (`execute-api`)
  - Secrets Manager
  - CloudWatch Logs
  - Bedrock Runtime
  - Textract
- **Secrets Manager** generated initial admin credential and session signing secret.
- **Existing S3 bucket/prefix** read access only:
  - bucket: `jta-data-bucket`
  - prefix: `JTA data set/`
- **Amazon Bedrock Claude 3.5 Sonnet** via configurable model ID.
- **Amazon Textract OCR** for supported image documents and scanned PDFs/TIFFs, including
  handwritten text detection.
- **React/Vite SPA** packaged into the Lambda bundle and served through the private API.

The CDK stack defaults to the Australia East AWS region (`ap-southeast-2`) when
`CDK_DEFAULT_REGION` is not set.

## Security model

- Runtime Lambdas are deployed into isolated private subnets with `natGateways: 0`.
- The API Gateway endpoint type is `PRIVATE` and its resource policy only permits calls
  from the created `execute-api` VPC endpoint.
- Authentication is local to the private app:
  - CDK creates a Secrets Manager secret with `adminUsername` and generated `adminPassword`.
  - The backend validates credentials server-side.
  - Sessions use HMAC-signed, `HttpOnly`, `Secure`, `SameSite=Strict` cookies.
- S3 permissions are scoped to listing and reading the configured prefix.
- Bedrock and Textract invocation is performed server-side; source document text is not
  returned to the browser.

> Note: Amazon Cognito user-pool browser authentication is intentionally not used because
> this app is intended to operate without internet access from the controlled network path.

## Supported source formats

The Lambda parser supports:

- `.txt`, `.text`, `.log`
- `.pdf` text extraction for text-based PDFs, with Textract OCR fallback for scanned or
  image-only PDFs
- `.jpg`, `.jpeg`, `.png` OCR through Textract
- `.tif`, `.tiff` asynchronous OCR through Textract
- `.docx`
- `.doc` best-effort legacy Word extraction
- `.md`, `.csv`, `.tsv`, `.json`, `.xml`, `.html`, `.htm`, `.rtf`, `.yaml`, `.yml`

Textract returns printed and handwritten text where it can confidently detect it. OCR
accuracy still depends on scan quality, handwriting legibility, skew, resolution, and
document contrast.

## Prompt template

The backend uses this embedded prompt structure:

- Write a 250-350 word testimonial for an Australian Defence Force member transitioning or
  exiting service.
- Use Australian English.
- Maintain a respectful, formal tone.
- Use only facts found in the selected source context.
- Do not invent ranks, postings, awards, dates, deployments, or achievements.
- Avoid headings, bullet points, markdown, citations, and source filenames.
- Include optional user instructions from the UI where provided.

## PDF template

The PDF export template includes:

- Title: `Australian Defence Force Service Testimonial`
- Member identifier
- Prepared date
- Edited testimonial text
- Review disclaimer and page footer

The user can edit the generated testimonial in the browser before exporting.

## Development

```bash
npm install
npm run build
npm run synth
```

## Deploy

Bootstrap CDK for the target account/region if needed, then deploy:

```bash
npm run cdk bootstrap
npm run deploy
```

To override defaults:

```bash
npm run deploy -- \
  -c bucketName=jta-data-bucket \
  -c "bucketPrefix=JTA data set/" \
  -c bedrockModelId=anthropic.claude-3-5-sonnet-20240620-v1:0 \
  -c 'privateClientCidrs=["10.0.0.0/8","172.16.0.0/12","192.168.0.0/16"]'
```

After deployment, retrieve the generated admin credential:

```bash
aws secretsmanager get-secret-value \
  --secret-id <InitialAdminCredentialsSecretArn> \
  --query SecretString \
  --output text
```

The secret format can also be replaced with:

```json
{
  "users": [
    {
      "username": "example.user",
      "password": "replace-with-controlled-password"
    }
  ]
}
```

For stronger stored credentials, use PBKDF2 fields:

```json
{
  "users": [
    {
      "username": "example.user",
      "salt": "base64-or-random-salt",
      "passwordHash": "base64-pbkdf2-sha256-hash",
      "iterations": 310000
    }
  ]
}
```

## Private access

Use the `PrivateApiUrl` output from a client that can resolve and route to the VPC
`execute-api` interface endpoint, such as a host connected through AWS Client VPN or an
equivalent private network connection. The frontend and API share the same private origin.
Set the `privateClientCidrs` CDK context value to the actual VPN/client CIDR ranges that
should be allowed to connect to the private endpoint.

## Bedrock and Textract prerequisites

Before deploying or using generation:

1. Confirm Bedrock is available in the target region.
2. Enable access to Claude 3.5 Sonnet for the AWS account.
3. Confirm the `bedrock-runtime` VPC endpoint service is available in the target region.
4. Confirm Textract and the `textract` VPC endpoint service are available in the target
   region.
5. If the approved model ID differs, pass `-c bedrockModelId=<approved-model-id>`.

For encrypted S3 objects, ensure the Lambda/Textract call path also has the required KMS
decrypt permissions.
