#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUTS_FILE="${ROOT_DIR}/cdk-outputs.json"
STACK_NAME="${STACK_NAME:-TestimonialsStack}"

if [[ -t 1 ]]; then
  BOLD="$(printf '\033[1m')"
  GREEN="$(printf '\033[32m')"
  YELLOW="$(printf '\033[33m')"
  RED="$(printf '\033[31m')"
  RESET="$(printf '\033[0m')"
else
  BOLD=""
  GREEN=""
  YELLOW=""
  RED=""
  RESET=""
fi

log() {
  printf '%s\n' "$*"
}

section() {
  printf '\n%s%s%s\n' "${BOLD}" "$*" "${RESET}"
}

success() {
  printf '%s%s%s\n' "${GREEN}" "$*" "${RESET}"
}

warn() {
  printf '%s%s%s\n' "${YELLOW}" "$*" "${RESET}"
}

fail() {
  printf '%sERROR:%s %s\n' "${RED}" "${RESET}" "$*" >&2
  exit 1
}

need_command() {
  local command_name="$1"
  local install_hint="$2"

  if ! command -v "${command_name}" >/dev/null 2>&1; then
    fail "Missing required command '${command_name}'. ${install_hint}"
  fi
}

prompt_value() {
  local variable_name="$1"
  local prompt_text="$2"
  local default_value="$3"
  local current_value="${!variable_name:-}"
  local answer=""

  if [[ -n "${current_value}" ]]; then
    printf -v "${variable_name}" '%s' "${current_value}"
    log "${prompt_text}: ${current_value} (from environment)"
    return
  fi

  if [[ "${NON_INTERACTIVE:-false}" == "true" ]]; then
    if [[ -z "${default_value}" ]]; then
      fail "${variable_name} must be set when NON_INTERACTIVE=true"
    fi
    printf -v "${variable_name}" '%s' "${default_value}"
    log "${prompt_text}: ${default_value} (default)"
    return
  fi

  read -r -p "${prompt_text} [${default_value}]: " answer
  printf -v "${variable_name}" '%s' "${answer:-${default_value}}"
}

prompt_yes_no() {
  local variable_name="$1"
  local prompt_text="$2"
  local default_value="$3"
  local current_value="${!variable_name:-}"
  local answer=""

  if [[ -n "${current_value}" ]]; then
    case "${current_value}" in
      y|Y|yes|YES|true|TRUE|1) printf -v "${variable_name}" 'true' ;;
      n|N|no|NO|false|FALSE|0) printf -v "${variable_name}" 'false' ;;
      *) fail "${variable_name} must be yes/no or true/false, got '${current_value}'" ;;
    esac
    log "${prompt_text}: ${!variable_name} (from environment)"
    return
  fi

  if [[ "${NON_INTERACTIVE:-false}" == "true" ]]; then
    case "${default_value}" in
      y|Y|yes|YES|true|TRUE|1) printf -v "${variable_name}" 'true' ;;
      n|N|no|NO|false|FALSE|0) printf -v "${variable_name}" 'false' ;;
      *) fail "Invalid default for ${variable_name}: ${default_value}" ;;
    esac
    log "${prompt_text}: ${!variable_name} (default)"
    return
  fi

  read -r -p "${prompt_text} [${default_value}]: " answer
  answer="${answer:-${default_value}}"
  case "${answer}" in
    y|Y|yes|YES|true|TRUE|1) printf -v "${variable_name}" 'true' ;;
    n|N|no|NO|false|FALSE|0) printf -v "${variable_name}" 'false' ;;
    *) fail "Please answer yes or no for '${prompt_text}'" ;;
  esac
}

json_escape() {
  node -e "process.stdout.write(JSON.stringify(process.argv[1]))" "$1"
}

read_output_value() {
  local output_key="$1"
  node -e "const fs=require('fs'); const p=process.argv[1]; const stack=process.argv[2]; const key=process.argv[3]; const data=JSON.parse(fs.readFileSync(p,'utf8')); process.stdout.write(data?.[stack]?.[key] || '');" "${OUTPUTS_FILE}" "${STACK_NAME}" "${output_key}"
}

normalize_private_cidrs() {
  node - "$1" <<'NODE'
const raw = process.argv[2] ?? "";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseValues(value) {
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (typeof parsed === "string") {
      return [parsed];
    }
  } catch {
    // Fall back to comma-separated input below.
  }

  return trimmed.split(",");
}

function cleanValue(value) {
  return String(value)
    .trim()
    .replace(/^[\s[\]("'`]+/, "")
    .replace(/[\s[\]("'`]+$/, "");
}

function isValidIpv4Cidr(value) {
  const match = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d|[12]\d|3[0-2])$/);
  if (!match) {
    return false;
  }
  return match.slice(1, 5).every((part) => Number(part) >= 0 && Number(part) <= 255);
}

const cidrs = parseValues(raw)
  .flatMap((value) => String(value).split(","))
  .map(cleanValue)
  .filter(Boolean);

if (!cidrs.length) {
  fail("At least one VPN/private client CIDR is required.");
}

for (const cidr of cidrs) {
  if (!isValidIpv4Cidr(cidr)) {
    fail(`Invalid IPv4 CIDR '${cidr}'. Use a value like 10.0.0.0/20. Do not include unmatched brackets.`);
  }
}

process.stdout.write(JSON.stringify([...new Set(cidrs)]));
NODE
}

run_step() {
  local label="$1"
  shift
  section "${label}"
  "$@"
}

cd "${ROOT_DIR}"

section "ADF Testimonial Generator - guided AWS terminal installer"
log "This installer deploys the private AWS app from this repository."
log "It is intended for AWS CloudShell, an EC2/admin terminal, or another AWS-authenticated terminal."
log "It will not create or modify your source S3 data bucket; it only grants the app read access to the configured prefix."

section "1. Checking required terminal tools"
need_command aws "Install or enable AWS CLI before running this installer."
need_command node "Install Node.js 20 or newer before running this installer."
need_command npm "Install npm before running this installer."
success "Required tools found."

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if [[ "${NODE_MAJOR}" -lt 20 ]]; then
  fail "Node.js 20 or newer is required. Current version: $(node --version)"
fi
success "Node.js version is $(node --version)."

section "2. Checking AWS identity"
AWS_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)"
AWS_CALLER_ARN="$(aws sts get-caller-identity --query Arn --output text 2>/dev/null || true)"

if [[ -z "${AWS_ACCOUNT_ID}" || "${AWS_ACCOUNT_ID}" == "None" ]]; then
  fail "AWS credentials are not configured. Run 'aws configure', set AWS_PROFILE, or use an AWS terminal role."
fi

success "AWS account: ${AWS_ACCOUNT_ID}"
success "AWS caller: ${AWS_CALLER_ARN}"

DEFAULT_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || true)}}"
DEFAULT_REGION="${DEFAULT_REGION:-ap-southeast-2}"

section "3. Deployment settings"
prompt_value AWS_REGION "AWS region" "${DEFAULT_REGION}"
export AWS_REGION
export AWS_DEFAULT_REGION="${AWS_REGION}"

prompt_value TESTIMONIAL_BUCKET "S3 bucket containing source documents" "jta-data-bucket"
prompt_value TESTIMONIAL_PREFIX "S3 prefix containing source documents" "JTA data set/"
prompt_value BEDROCK_MODEL_ID "Bedrock model ID" "anthropic.claude-3-5-sonnet-20240620-v1:0"
prompt_value PRIVATE_CLIENT_CIDRS "VPN/private client CIDRs, comma-separated, for example 10.0.0.0/20" "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"
PRIVATE_CLIENT_CIDRS_JSON="$(normalize_private_cidrs "${PRIVATE_CLIENT_CIDRS}")"
PRIVATE_CLIENT_CIDRS="$(node -e "process.stdout.write(JSON.parse(process.argv[1]).join(','))" "${PRIVATE_CLIENT_CIDRS_JSON}")"
prompt_yes_no CHECK_S3_PREFIX "Check whether the configured S3 prefix is listable before deploying?" "y"
prompt_yes_no RUN_CDK_BOOTSTRAP "Run CDK bootstrap for this AWS account and region?" "y"
prompt_yes_no AUTO_APPROVE_CDK "Make CDK deployment non-interactive after this installer confirmation?" "y"
prompt_yes_no RETRIEVE_ADMIN_SECRET "Print the generated admin credential command after deployment?" "y"

section "4. Confirm deployment"
log "The installer will deploy with these values:"
log "  AWS account:          ${AWS_ACCOUNT_ID}"
log "  AWS region:           ${AWS_REGION}"
log "  Stack name:           ${STACK_NAME}"
log "  S3 bucket:            ${TESTIMONIAL_BUCKET}"
log "  S3 prefix:            ${TESTIMONIAL_PREFIX}"
log "  Bedrock model ID:     ${BEDROCK_MODEL_ID}"
log "  Private client CIDRs: ${PRIVATE_CLIENT_CIDRS}"
log ""
warn "Only continue if this is the correct AWS account and region."
prompt_yes_no CONFIRM_INSTALL "Proceed with dependency install, build, synth, and AWS deployment?" "y"

if [[ "${CONFIRM_INSTALL}" != "true" ]]; then
  fail "Installer cancelled by user."
fi

if [[ "${CHECK_S3_PREFIX}" == "true" ]]; then
  section "5. Checking S3 prefix visibility"
  if aws s3 ls "s3://${TESTIMONIAL_BUCKET}/${TESTIMONIAL_PREFIX}" --region "${AWS_REGION}" >/dev/null 2>&1; then
    success "S3 prefix is listable with the current AWS identity."
  else
    warn "Could not list s3://${TESTIMONIAL_BUCKET}/${TESTIMONIAL_PREFIX}"
    warn "This may be expected if your deployment identity cannot list the source bucket."
    warn "The deployed Lambda still needs permission and bucket policy access at runtime."
    prompt_yes_no CONTINUE_AFTER_S3_WARNING "Continue despite the S3 pre-check warning?" "y"
    if [[ "${CONTINUE_AFTER_S3_WARNING}" != "true" ]]; then
      fail "Installer stopped after S3 pre-check warning."
    fi
  fi
else
  section "5. Skipping S3 prefix visibility check"
fi

section "6. Installing Node dependencies"
if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi

run_step "7. Building application" npm run build

if [[ "${RUN_CDK_BOOTSTRAP}" == "true" ]]; then
  section "8. Running CDK bootstrap"
  npx cdk bootstrap "aws://${AWS_ACCOUNT_ID}/${AWS_REGION}"
else
  section "8. Skipping CDK bootstrap"
fi

run_step "9. Synthesizing CloudFormation template" npm run synth

DEPLOY_ARGS=(
  "${STACK_NAME}"
  "--outputs-file" "${OUTPUTS_FILE}"
  "-c" "bucketName=${TESTIMONIAL_BUCKET}"
  "-c" "bucketPrefix=${TESTIMONIAL_PREFIX}"
  "-c" "bedrockModelId=${BEDROCK_MODEL_ID}"
  "-c" "privateClientCidrs=${PRIVATE_CLIENT_CIDRS_JSON}"
)

if [[ "${AUTO_APPROVE_CDK}" == "true" ]]; then
  DEPLOY_ARGS+=("--require-approval" "never")
fi

section "10. Deploying AWS stack"
log "Running CDK deploy. This can take several minutes."
npx cdk deploy "${DEPLOY_ARGS[@]}"

section "11. Deployment outputs"
if [[ ! -f "${OUTPUTS_FILE}" ]]; then
  warn "CDK did not write ${OUTPUTS_FILE}; check the deploy output above for stack outputs."
else
  PRIVATE_API_URL="$(read_output_value PrivateApiUrl)"
  EXECUTE_API_VPCE_ID="$(read_output_value ExecuteApiVpcEndpointId)"
  ADMIN_SECRET_ARN="$(read_output_value InitialAdminCredentialsSecretArn)"

  log "Private API URL:"
  log "  ${PRIVATE_API_URL:-not found in outputs file}"
  log ""
  log "execute-api VPC endpoint ID:"
  log "  ${EXECUTE_API_VPCE_ID:-not found in outputs file}"
  log ""
  log "Initial admin credential secret ARN:"
  log "  ${ADMIN_SECRET_ARN:-not found in outputs file}"

  if [[ "${RETRIEVE_ADMIN_SECRET}" == "true" && -n "${ADMIN_SECRET_ARN}" ]]; then
    section "12. Retrieve initial login credential"
    log "Run this command when you are ready to view the generated admin password:"
    log ""
    log "aws secretsmanager get-secret-value \\"
    log "  --region \"${AWS_REGION}\" \\"
    log "  --secret-id \"${ADMIN_SECRET_ARN}\" \\"
    log "  --query SecretString \\"
    log "  --output text"
    log ""
    warn "The command prints the generated password to your terminal. Handle it according to your organisation's password handling rules."
  fi
fi

section "Install complete"
success "The private testimonial generator stack deployment command completed."
log "Next steps:"
log "1. Connect from a VPN/private network client allowed by: ${PRIVATE_CLIENT_CIDRS}"
log "2. Open the Private API URL shown above."
log "3. Log in with the generated admin credential from Secrets Manager."
log "4. Search for an identifier, select files, generate, edit, and export the testimonial PDF."

