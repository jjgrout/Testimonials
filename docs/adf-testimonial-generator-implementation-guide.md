# ADF Testimonial Generator - End-to-End Implementation Guide

Document purpose: This guide explains, in detailed and beginner-friendly language, how to deploy, configure, access, test, operate, and troubleshoot the private AWS testimonial generator application.

Audience: This guide is written for someone who may not already know AWS, CDK, VPC networking, Bedrock, Textract, Lambda, S3, or private API Gateway. It explains what each action does, why the action matters, and how to confirm that each step worked.

Application summary: The application lets an authorised user search a private S3 document set for a person's identifier, select source files, extract readable text from the selected files, use Amazon Bedrock Claude 3.5 Sonnet to draft a 250-350 word Australian Defence Force service testimonial, edit the draft, and export the final text as a formatted PDF.

Current repository branch:

```text
cursor/private-testimonial-app-66e4
```

Current pull request:

```text
https://github.com/jjgrout/Testimonials/pull/1
```

---

# 1. Important plain-language overview

## 1.1 What you are deploying

You are deploying a private web application into AWS.

The application has two major parts:

1. A frontend.
   - This is the web page that the user sees in their browser.
   - It contains the login page, search box, file selection list, generation button, text editor, and PDF export button.

2. A backend.
   - This is server-side code running in AWS Lambda.
   - It handles login, S3 searching, document parsing, OCR, Bedrock generation, and PDF creation.

The frontend and backend are both served through a private API Gateway URL. This means there is no public website endpoint intended for general internet access.

## 1.2 What "private" means in this solution

In this context, "private" means:

- The application is deployed inside an AWS Virtual Private Cloud, usually shortened to VPC.
- The Lambda function runs in isolated private subnets.
- The Lambda function has no NAT gateway.
- The Lambda function has no normal internet route.
- The application uses AWS VPC endpoints to talk privately to AWS services.
- Users must connect through a private network path such as VPN, Direct Connect, or an internal AWS host.
- The API Gateway is configured as a private API.

Private does not automatically mean "secure enough for all production workloads." It means the network path is restricted. You should still review identity, logging, KMS, auditing, data handling, and organisational security requirements before production use.

## 1.3 What "serverless where possible" means here

Serverless means AWS manages the servers for you. You do not create or patch EC2 application servers for this app.

This solution uses:

- AWS Lambda for backend compute.
- API Gateway for HTTP routing.
- Secrets Manager for stored credentials and session signing secret.
- S3 as the existing document source.
- Bedrock for testimonial text generation.
- Textract for OCR.
- CloudWatch Logs for Lambda logs.

The VPC and VPC endpoints are not "serverless" in the same sense, but they are managed network infrastructure required for private operation.

---

# 2. High-level user workflow

The person using the application follows this workflow:

1. Connect to the private network or VPN.
2. Open the private application URL in a browser.
3. Log in with a username and password.
4. Enter a person's identifier.
5. Search the configured S3 prefix for files with that identifier in the object title.
6. Select the files to use as source context.
7. Optionally enter extra generation instructions.
8. Generate the testimonial.
9. Review and edit the generated text.
10. Export the final edited text as a PDF.

Example:

```text
Identifier entered by user: SMITH123

The application searches S3 object names under:
s3://jta-data-bucket/JTA data set/

The application might find:
JTA data set/SMITH123_Service_Record.pdf
JTA data set/SMITH123_Commander_Notes.docx
JTA data set/SMITH123_Handwritten_Appraisal.jpg

The user selects the files.
The backend extracts text and OCR.
Bedrock drafts the testimonial.
The user edits the testimonial.
The user exports the PDF.
```

---

# 3. AWS services used and what each one does

## 3.1 AWS CDK

AWS CDK stands for Cloud Development Kit.

It lets you define AWS infrastructure using normal programming languages. This solution uses TypeScript.

Instead of manually clicking through the AWS Console to create every Lambda, security group, VPC endpoint, and API Gateway, you run:

```bash
npm run deploy
```

CDK then creates or updates the AWS resources described in the code.

## 3.2 VPC

VPC stands for Virtual Private Cloud.

Think of it as a private network inside AWS.

This solution creates a VPC with CIDR:

```text
10.42.0.0/16
```

That CIDR means the VPC can contain private IP addresses in the range:

```text
10.42.0.0 through 10.42.255.255
```

## 3.3 Isolated private subnets

A subnet is a smaller network range inside a VPC.

This app creates isolated private subnets.

Isolated means:

- The subnet does not have a route to an internet gateway.
- The subnet does not have a route to a NAT gateway.
- Resources in the subnet cannot make normal outbound internet calls.

The Lambda backend runs in these isolated subnets.

## 3.4 VPC endpoints

A VPC endpoint lets private resources talk to AWS services without going through the public internet.

This application creates endpoints for:

```text
S3
execute-api
Secrets Manager
CloudWatch Logs
Bedrock Runtime
Textract
```

These endpoints are required because the Lambda has no internet access.

## 3.5 API Gateway private REST API

API Gateway receives browser requests and sends them to Lambda.

This solution uses a private API Gateway endpoint.

That means:

- The API is not intended to be reachable from the public internet.
- It can be called through the execute-api VPC endpoint.
- The API resource policy restricts calls to the created execute-api VPC endpoint.

## 3.6 Lambda

AWS Lambda runs backend code without you managing servers.

This Lambda does several jobs:

- Serves the frontend files.
- Handles login.
- Searches S3.
- Downloads selected documents from S3.
- Extracts text from supported file formats.
- Calls Textract for OCR.
- Calls Bedrock to generate the testimonial.
- Creates the final PDF.

## 3.7 S3

S3 stores the source documents.

This solution expects the existing bucket and prefix:

```text
Bucket: jta-data-bucket
Prefix: JTA data set/
Full location: s3://jta-data-bucket/JTA data set/
```

The application has read-only access to this prefix.

## 3.8 Secrets Manager

Secrets Manager stores sensitive values.

This solution creates:

1. An initial username/password secret.
2. A session signing secret used to sign browser login cookies.

The generated admin username defaults to:

```text
admin
```

The password is generated by AWS Secrets Manager during deployment.

## 3.9 Bedrock

Amazon Bedrock provides access to foundation models.

This app uses Claude 3.5 Sonnet to draft the testimonial.

Default model ID:

```text
anthropic.claude-3-5-sonnet-20240620-v1:0
```

## 3.10 Textract

Amazon Textract extracts text from images and scanned documents.

This app uses Textract for:

- Printed text OCR.
- Handwritten text OCR where Textract can detect it.
- Image files such as `.jpg`, `.jpeg`, and `.png`.
- Scanned PDFs and TIFF files.

Important note: handwriting OCR is never perfect. Results depend on legibility, scan quality, resolution, lighting, skew, and document contrast.

---

# 4. Files and folders in the repository

These are the most important files:

```text
bin/testimonials.ts
```

This is the CDK entry point. It starts the CDK application.

```text
lib/testimonials-stack.ts
```

This defines the AWS infrastructure: VPC, endpoints, Lambda, API Gateway, IAM permissions, and secrets.

```text
src/backend/app.ts
```

This is the Lambda backend code. It contains login, S3 search, parsing, OCR, Bedrock generation, and PDF export.

```text
src/frontend/main.tsx
```

This is the React frontend.

```text
src/frontend/styles.css
```

This is the frontend styling.

```text
cdk.json
```

This stores default CDK configuration values such as bucket name, prefix, model ID, and private client CIDRs.

```text
README.md
```

This is the shorter repository overview.

```text
docs/adf-testimonial-generator-implementation-guide.md
```

This is the source text for the detailed implementation guide.

```text
docs/adf-testimonial-generator-implementation-guide.docx
```

This is the editable Microsoft Word document generated from the guide.

```text
scripts/generate-guide-docx.mjs
```

This regenerates the DOCX file from the Markdown source.

---

# 5. Before you deploy: checklist

Complete this checklist before running the deployment.

## 5.1 You have AWS account access

You need permissions to create and manage:

- VPCs
- Subnets
- Route tables
- VPC endpoints
- Security groups
- Lambda functions
- API Gateway REST APIs
- IAM roles and policies
- Secrets Manager secrets
- CloudWatch log groups

Simple check:

```bash
aws sts get-caller-identity
```

Expected result:

```json
{
  "UserId": "...",
  "Account": "123456789012",
  "Arn": "arn:aws:iam::123456789012:user/your-user"
}
```

If this command fails, your terminal is not authenticated to AWS.

## 5.2 You are using Australia East

Set the region:

```bash
export AWS_REGION=ap-southeast-2
export AWS_DEFAULT_REGION=ap-southeast-2
```

Check:

```bash
aws configure get region
```

If you use an AWS profile, set it:

```bash
export AWS_PROFILE=your-profile-name
```

Then check again:

```bash
aws sts get-caller-identity
```

## 5.3 The S3 bucket and prefix exist

Run:

```bash
aws s3 ls "s3://jta-data-bucket/JTA data set/"
```

If the prefix exists and has files, you will see output similar to:

```text
2026-06-01 10:15:00      12345 SMITH123_Service_Record.pdf
2026-06-01 10:16:00      54321 SMITH123_Commander_Notes.docx
```

If you see an error like `NoSuchBucket`, the bucket name is wrong or the bucket does not exist.

If you see `AccessDenied`, your deployment identity may not have permission to list the bucket.

## 5.4 Bedrock access is enabled

In the AWS Console:

1. Open Amazon Bedrock.
2. Select region `ap-southeast-2`.
3. Open model access settings.
4. Confirm Claude 3.5 Sonnet is enabled.

If the model is not enabled, Bedrock generation will fail even if the application deploys successfully.

## 5.5 Textract is available

Confirm Amazon Textract is available in the chosen region.

The application uses Textract for OCR. If the service or VPC endpoint is unavailable in your region, scanned document OCR will not work.

## 5.6 You know the VPN/client CIDR

The app's private API endpoint security group only allows selected client network ranges.

A CIDR is a compact way of describing a network range.

Examples:

```text
10.50.0.0/22
192.168.20.0/24
172.16.100.0/24
```

If your VPN assigns client IPs from `10.50.0.0/22`, then use:

```text
10.50.0.0/22
```

Do not leave broad ranges in production unless your security team approves them.

---

# 6. Install required local software

You need Node.js, npm, AWS CLI, and AWS CDK.

## 6.1 Check Node.js

Run:

```bash
node --version
```

Recommended:

```text
v20.x or newer
```

Check npm:

```bash
npm --version
```

## 6.2 Check AWS CLI

Run:

```bash
aws --version
```

Then verify identity:

```bash
aws sts get-caller-identity
```

## 6.3 CDK is run through npm

You do not need to globally install CDK. The repository includes the CDK package.

Commands use:

```bash
npm run cdk
```

or:

```bash
npx cdk
```

---

# 7. Get the code

Clone the repository:

```bash
git clone https://github.com/jjgrout/Testimonials.git
```

Enter the folder:

```bash
cd Testimonials
```

Checkout the implementation branch:

```bash
git checkout cursor/private-testimonial-app-66e4
```

Install dependencies:

```bash
npm install
```

What this does:

- Reads `package.json`.
- Downloads required Node packages.
- Creates or updates `node_modules`.
- Uses `package-lock.json` to keep dependency versions consistent.

---

# 8. Understand and review configuration

Open:

```text
cdk.json
```

You should see values similar to:

```json
{
  "app": "npx tsx bin/testimonials.ts",
  "context": {
    "bucketName": "jta-data-bucket",
    "bucketPrefix": "JTA data set/",
    "bedrockModelId": "anthropic.claude-3-5-sonnet-20240620-v1:0",
    "privateClientCidrs": ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]
  }
}
```

Explanation of each value:

```text
bucketName
```

The S3 bucket where documents are stored.

```text
bucketPrefix
```

The folder-like prefix inside the S3 bucket.

```text
bedrockModelId
```

The Bedrock model used to write the testimonial.

```text
privateClientCidrs
```

The private network ranges allowed to connect to the private application endpoint.

Production example with a tighter VPN range:

```bash
npm run deploy -- \
  -c bucketName=jta-data-bucket \
  -c "bucketPrefix=JTA data set/" \
  -c bedrockModelId=anthropic.claude-3-5-sonnet-20240620-v1:0 \
  -c 'privateClientCidrs=["10.50.0.0/22"]'
```

---

# 9. Build and test before deployment

Run:

```bash
npm run build
```

This does two things:

1. Type-checks the TypeScript code.
2. Builds the frontend web application.

Expected success output includes:

```text
tsc --noEmit
vite build
```

Run:

```bash
npm run synth
```

This asks CDK to generate the CloudFormation template.

CloudFormation is the AWS service that actually creates the resources.

If `npm run synth` succeeds, it means CDK can understand your infrastructure code.

Run:

```bash
npm test
```

Currently this runs TypeScript type checking.

---

# 10. Bootstrap CDK

CDK bootstrap prepares your AWS account and region for CDK deployments.

It creates a staging bucket and roles used by CDK.

Get your AWS account ID:

```bash
aws sts get-caller-identity --query Account --output text
```

Example output:

```text
123456789012
```

Bootstrap:

```bash
npx cdk bootstrap aws://123456789012/ap-southeast-2
```

Replace `123456789012` with your real account ID.

If bootstrap has already been done, this command usually completes safely.

---

# 11. Deploy the app

Basic deployment:

```bash
npm run deploy
```

Recommended deployment with explicit values:

```bash
npm run deploy -- \
  -c bucketName=jta-data-bucket \
  -c "bucketPrefix=JTA data set/" \
  -c bedrockModelId=anthropic.claude-3-5-sonnet-20240620-v1:0 \
  -c 'privateClientCidrs=["YOUR_VPN_CLIENT_CIDR"]'
```

Replace:

```text
YOUR_VPN_CLIENT_CIDR
```

with the actual VPN/client network range.

Example:

```bash
npm run deploy -- \
  -c bucketName=jta-data-bucket \
  -c "bucketPrefix=JTA data set/" \
  -c bedrockModelId=anthropic.claude-3-5-sonnet-20240620-v1:0 \
  -c 'privateClientCidrs=["10.50.0.0/22"]'
```

During deployment, CDK may ask:

```text
Do you wish to deploy these changes (y/n)?
```

Type:

```text
y
```

Then press Enter.

Deployment can take several minutes because VPC endpoints and Lambda resources must be created.

---

# 12. Save the deployment outputs

At the end of deployment, CDK prints outputs.

Save these values:

```text
PrivateApiUrl
ExecuteApiVpcEndpointId
InitialAdminCredentialsSecretArn
```

Example:

```text
TestimonialsStack.PrivateApiUrl = https://abc123.execute-api.ap-southeast-2.amazonaws.com/prod/
TestimonialsStack.ExecuteApiVpcEndpointId = vpce-0123456789abcdef0
TestimonialsStack.InitialAdminCredentialsSecretArn = arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:...
```

What each one means:

```text
PrivateApiUrl
```

The private URL users open in the browser.

```text
ExecuteApiVpcEndpointId
```

The VPC endpoint that private users must route through to reach the API.

```text
InitialAdminCredentialsSecretArn
```

The secret containing the generated admin login.

---

# 13. Retrieve the generated admin credentials

Run:

```bash
aws secretsmanager get-secret-value \
  --secret-id "<InitialAdminCredentialsSecretArn>" \
  --query SecretString \
  --output text
```

Replace:

```text
<InitialAdminCredentialsSecretArn>
```

with the real output value.

Example:

```bash
aws secretsmanager get-secret-value \
  --secret-id "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:TestimonialsStack-AuthCredentialsSecret-AbCdEf" \
  --query SecretString \
  --output text
```

Expected result:

```json
{
  "adminUsername": "admin",
  "adminPassword": "EXAMPLE_GENERATED_PASSWORD"
}
```

Use:

```text
Username: admin
Password: EXAMPLE_GENERATED_PASSWORD
```

Do not email or chat the password in plain text unless your organisation's process permits it.

---

# 14. Configure user access through VPN or private network

The application URL will not work from a normal public internet browser unless that browser is on a network path that can reach the private API endpoint.

Users need one of the following:

- AWS Client VPN.
- Site-to-Site VPN.
- Direct Connect.
- A browser running on an internal host inside the VPC.
- Another approved private network path.

## 14.1 What must be true for browser access

The user's computer must be able to:

1. Resolve the private API DNS name.
2. Route to the execute-api VPC endpoint.
3. Connect to TCP port 443.
4. Come from a source IP allowed by `privateClientCidrs`.

## 14.2 Example with AWS Client VPN

Suppose your Client VPN gives users IP addresses in:

```text
10.50.0.0/22
```

Then deploy with:

```bash
-c 'privateClientCidrs=["10.50.0.0/22"]'
```

Your VPN also needs routes and authorisation rules that allow access to the app VPC:

```text
10.42.0.0/16
```

You also need DNS configured so private AWS names resolve correctly.

## 14.3 Test network connectivity

From a VPN-connected client, open the `PrivateApiUrl` in a browser.

If DNS and routing are correct, you should see the login page.

If the page does not load, see the troubleshooting section near the end of this guide.

---

# 15. First login test

Open the private URL:

```text
https://abc123.execute-api.ap-southeast-2.amazonaws.com/prod/
```

Use the actual `PrivateApiUrl` from CDK outputs.

The page should show:

```text
ADF Testimonial Generator
```

Enter:

```text
Username: admin
Password: password from Secrets Manager
```

Click:

```text
Sign in
```

Expected result:

- The login page disappears.
- The main application page appears.
- You see a search field for a person identifier.

---

# 16. Search for source files

In the application, enter an identifier.

Example:

```text
SMITH123
```

Click:

```text
Search S3
```

What happens behind the scenes:

1. Browser sends the search request to the private API.
2. Lambda checks your login session cookie.
3. Lambda lists objects under:

```text
s3://jta-data-bucket/JTA data set/
```

4. Lambda compares the identifier to each object filename.
5. Matching files are returned to the browser.

Example files:

```text
JTA data set/SMITH123_Service_Record.pdf
JTA data set/SMITH123_Commander_Statement.docx
JTA data set/SMITH123_Handwritten_Appraisal.jpg
```

The browser does not receive the document contents at this stage. It only receives metadata such as filename, key, extension, size, and supported status.

---

# 17. Select files for context

Tick the checkbox beside each file that should be used.

Choose files that are relevant to the person's service.

Good examples:

- Service record summaries.
- Commander comments.
- Performance reports.
- Training summaries.
- Awards or commendation text.
- Exit documents.
- Relevant handwritten notes that Textract can OCR.

Avoid selecting unrelated or duplicate files.

Why selection matters:

- Bedrock can only write from the context it receives.
- More files are not always better.
- Irrelevant documents can dilute or confuse the generated testimonial.
- The app enforces a maximum selected file count to keep requests manageable.

---

# 18. Generate the testimonial

Optionally enter additional instructions.

Example:

```text
Emphasise leadership, mentoring, and operational reliability where supported by the documents.
```

Click:

```text
Generate 250-350 word testimonial
```

What happens behind the scenes:

1. Lambda downloads each selected object from S3.
2. Lambda identifies the file type by extension.
3. Lambda extracts text from the file.
4. If OCR is needed, Lambda calls Textract.
5. Lambda builds the Bedrock prompt.
6. Lambda sends the prompt and source context to Claude 3.5 Sonnet.
7. Bedrock returns a draft testimonial.
8. Lambda sends only the generated testimonial back to the browser.

Important: The backend does not send the full source document text back to the browser.

---

# 19. File type handling

## 19.1 Plain text files

Supported examples:

```text
.txt
.text
.log
.md
.csv
.tsv
.json
.xml
.html
.htm
.rtf
.yaml
.yml
```

These are decoded as text or lightly cleaned.

## 19.2 Word documents

Supported:

```text
.docx
.doc
```

`.docx` files use DOCX text extraction.

Legacy `.doc` files use best-effort Word extraction.

Legacy Word files can be inconsistent. If one fails, convert it to `.docx` and upload the converted file.

## 19.3 Text-based PDFs

Some PDFs contain real embedded text.

For those, the app extracts text directly from the PDF.

## 19.4 Scanned PDFs

Some PDFs are just images of pages.

For those, normal PDF text extraction returns little or no text.

The app then falls back to Textract OCR.

## 19.5 Image files

Supported:

```text
.jpg
.jpeg
.png
```

The app sends these to Textract OCR.

## 19.6 TIFF files

Supported:

```text
.tif
.tiff
```

The app uses Textract asynchronous text detection.

## 19.7 Handwritten text

Textract can detect handwriting in many cases.

However, handwritten OCR depends heavily on quality.

Better results usually come from:

- Dark text on light background.
- Clear handwriting.
- Straight scans.
- High resolution.
- No shadows.
- No heavy compression.
- No overlapping stamps or markings.

Poor results may come from:

- Cursive or messy handwriting.
- Faint pencil.
- Skewed pages.
- Low-resolution photos.
- Shadows or glare.
- Text over patterned backgrounds.

---

# 20. Review and edit the testimonial

After generation, the testimonial appears in an editable text box.

The user should carefully review:

- Names or identifiers.
- Rank if mentioned.
- Dates if mentioned.
- Awards or qualifications.
- Postings.
- Deployments.
- Tone.
- Word count.
- Grammar.
- Whether every factual claim is supported by the source files.

The prompt tells Bedrock not to invent details, but the final text must still be reviewed by a human.

The target length is:

```text
250-350 words
```

If the output is too short or too long, edit it manually or regenerate with more specific instructions.

---

# 21. Export the PDF

When the testimonial is ready, click:

```text
Export formatted PDF
```

The backend creates a PDF with:

- Title.
- Member identifier.
- Prepared date.
- Testimonial body.
- Review disclaimer.
- Page footer.

The downloaded filename uses the identifier.

Example:

```text
SMITH123-testimonial.pdf
```

---

# 22. Change the prompt template

The prompt template is in:

```text
src/backend/app.ts
```

Function:

```ts
buildTestimonialPrompt(...)
```

Change this function if you want to adjust:

- Tone.
- Word count.
- Formality.
- Required inclusions.
- Prohibited claims.
- Whether headings are allowed.
- Whether citations are allowed.

Example instruction currently included:

```text
Do not invent ranks, postings, awards, qualifications, dates, deployments, or achievements that are not supported by the source context.
```

This is important because generative AI can otherwise produce plausible-sounding but unsupported claims.

After changing the prompt:

```bash
npm run build
npm run synth
npm run deploy
```

---

# 23. Change the PDF template

The PDF template is in:

```text
src/backend/app.ts
```

Function:

```ts
buildPdf(...)
```

Change this function if you want to adjust:

- Page margins.
- Font size.
- Header text.
- Footer text.
- Disclaimer.
- Date format.
- Spacing.
- Organisation-specific wording.

After changing the PDF layout:

```bash
npm run build
npm run synth
npm run deploy
```

---

# 24. Change users and passwords

The initial deployment creates one generated admin credential.

You can replace the secret value in AWS Secrets Manager.

## 24.1 Simple multiple-user format

Example:

```json
{
  "users": [
    {
      "username": "alice.example",
      "password": "replace-with-controlled-password"
    },
    {
      "username": "bob.example",
      "password": "replace-with-controlled-password"
    }
  ]
}
```

## 24.2 Stronger hashed-password format

Example:

```json
{
  "users": [
    {
      "username": "alice.example",
      "salt": "random-salt-value",
      "passwordHash": "base64-pbkdf2-sha256-hash",
      "iterations": 310000
    }
  ]
}
```

Plain password storage is easier to operate but less secure.

Hashed password storage is preferred for production if you keep local username/password authentication.

---

# 25. Logs and monitoring

Lambda logs go to CloudWatch Logs.

To view logs in AWS Console:

1. Open CloudWatch.
2. Open Log groups.
3. Find the application Lambda log group.
4. Open the latest log stream.

Useful things to look for:

- Login failures.
- S3 access errors.
- Document parsing errors.
- Textract errors.
- Bedrock errors.
- Timeouts.

Recommended production alarms:

- Lambda errors greater than zero.
- Lambda throttles greater than zero.
- Lambda duration close to timeout.
- API Gateway 5XX errors.
- Bedrock invocation errors.
- Textract failures.

---

# 26. Common problems and exact checks

## 26.1 The application URL does not open

Likely causes:

- You are not connected to VPN.
- Your VPN route is missing.
- DNS is not resolving the private execute-api name.
- Your client CIDR was not included in `privateClientCidrs`.
- The execute-api endpoint security group does not allow your source IP.

Checks:

1. Confirm you are on VPN.
2. Confirm your client IP is in the allowed CIDR.
3. Confirm the VPN can route to:

```text
10.42.0.0/16
```

4. Confirm private DNS is enabled for the execute-api endpoint.
5. Confirm the `PrivateApiUrl` is correct.

## 26.2 Login does not work

Likely causes:

- Wrong username.
- Wrong password.
- Secret was edited into the wrong format.
- Lambda cannot reach Secrets Manager endpoint.

Checks:

```bash
aws secretsmanager get-secret-value \
  --secret-id "<InitialAdminCredentialsSecretArn>" \
  --query SecretString \
  --output text
```

Confirm the JSON contains either:

```json
{
  "adminUsername": "admin",
  "adminPassword": "..."
}
```

or:

```json
{
  "users": [
    {
      "username": "...",
      "password": "..."
    }
  ]
}
```

## 26.3 S3 search returns no files

Likely causes:

- Identifier does not appear in the object title.
- Files are outside the configured prefix.
- Prefix spelling differs.
- Lambda lacks S3 list permission.

Check manually:

```bash
aws s3 ls "s3://jta-data-bucket/JTA data set/" --recursive
```

Look for the identifier in filenames.

## 26.4 S3 search gives AccessDenied

Likely causes:

- Bucket policy blocks access.
- IAM permissions are missing.
- KMS permissions are missing for encrypted metadata or objects.

Check CloudWatch Lambda logs for exact error details.

## 26.5 OCR fails

Likely causes:

- Textract is not available in the region.
- Textract VPC endpoint is missing or unavailable.
- File type is not supported by Textract.
- File is corrupted.
- File is encrypted and KMS decrypt permissions are missing.
- The scan has no readable text.

Try:

- Upload a clear PNG or JPEG test image with printed text.
- Search for it.
- Select it.
- Generate using only that file.

If that works, the OCR path is functioning.

## 26.6 Handwriting OCR is poor

Likely causes:

- Handwriting is unclear.
- Image resolution is too low.
- Photo has shadows or glare.
- Document is skewed.
- Text overlaps lines, stamps, or graphics.

Recommended improvement:

- Rescan at higher resolution.
- Use flatbed scanning if possible.
- Increase contrast.
- Rotate pages upright.
- Avoid shadows.

## 26.7 Bedrock generation fails

Likely causes:

- Claude model access is not enabled.
- Wrong model ID.
- Bedrock Runtime endpoint issue.
- Account quota issue.
- Source context is too large.

Checks:

1. Confirm model access in Bedrock Console.
2. Confirm model ID.
3. Check Lambda logs.
4. Try selecting fewer files.

## 26.8 PDF export fails

Likely causes:

- Empty testimonial text.
- Lambda error.
- Browser download blocked.

Checks:

1. Confirm there is text in the editor.
2. Try another browser.
3. Check Lambda logs.

---

# 27. Production hardening recommendations

Before production use, consider these improvements:

1. Tighten `privateClientCidrs` to exact approved ranges.
2. Replace the generated admin account with named user accounts.
3. Use hashed passwords or private SSO integration.
4. Add CloudWatch alarms.
5. Add API access logging if required.
6. Add KMS decrypt permissions if documents are encrypted.
7. Review Bedrock data handling requirements.
8. Review Textract data handling requirements.
9. Add an approved final PDF letterhead/template.
10. Add an approved prompt template.
11. Run a security review.
12. Run user acceptance testing with real document samples.
13. Consider asynchronous OCR workflow for very large scanned PDFs.

---

# 28. When to consider an asynchronous OCR redesign

The current app waits for OCR to finish during the generate request.

This is simpler for users, but very large scanned PDFs can take longer.

Consider redesigning OCR as an asynchronous workflow if:

- Scanned PDFs are often very large.
- OCR regularly approaches the Lambda timeout.
- Users need progress updates.
- You want retryable OCR jobs.
- You want extracted text cached for reuse.

An asynchronous design would usually add:

- DynamoDB for job status.
- S3 for extracted text storage.
- Step Functions or EventBridge for orchestration.
- Frontend polling for job progress.

---

# 29. Updating the deployed app after code changes

After making code changes:

```bash
npm run build
npm run synth
npm run deploy
```

If using deployment overrides:

```bash
npm run deploy -- \
  -c bucketName=jta-data-bucket \
  -c "bucketPrefix=JTA data set/" \
  -c bedrockModelId=anthropic.claude-3-5-sonnet-20240620-v1:0 \
  -c 'privateClientCidrs=["10.50.0.0/22"]'
```

---

# 30. Removing the app

To delete the resources created by this CDK stack:

```bash
npx cdk destroy
```

Important:

- This removes the app infrastructure.
- This does not delete the existing source S3 bucket because the stack references it as an existing bucket.
- Confirm with your organisation before destroying any environment.

---

# 31. Final acceptance test checklist

Use this checklist after deployment:

1. VPN/private network connection works.
2. Private app URL opens.
3. Login works with Secrets Manager credentials.
4. Search finds files by identifier.
5. TXT extraction works.
6. DOCX extraction works.
7. DOC extraction works if legacy DOC files are present.
8. Text-based PDF extraction works.
9. Scanned PDF OCR works.
10. JPEG/PNG OCR works.
11. Handwritten OCR is tested with realistic samples.
12. Bedrock generation works.
13. Generated testimonial is 250-350 words or close enough for editing.
14. User can edit text.
15. PDF export downloads successfully.
16. CloudWatch logs show no unexpected errors.
17. Security team has reviewed private CIDRs, IAM permissions, and data handling.

---

# 32. Quick command reference

Install dependencies:

```bash
npm install
```

Build:

```bash
npm run build
```

Synthesize CDK:

```bash
npm run synth
```

Test:

```bash
npm test
```

Bootstrap:

```bash
npx cdk bootstrap aws://ACCOUNT_ID/ap-southeast-2
```

Deploy:

```bash
npm run deploy -- \
  -c bucketName=jta-data-bucket \
  -c "bucketPrefix=JTA data set/" \
  -c bedrockModelId=anthropic.claude-3-5-sonnet-20240620-v1:0 \
  -c 'privateClientCidrs=["10.50.0.0/22"]'
```

Retrieve admin credentials:

```bash
aws secretsmanager get-secret-value \
  --secret-id "<InitialAdminCredentialsSecretArn>" \
  --query SecretString \
  --output text
```

Regenerate this DOCX:

```bash
npm run docs:docx
```

