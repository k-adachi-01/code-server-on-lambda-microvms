# Requirements Document

## Introduction

This project (Kiro University Challenge 2026, greenfield) provides an ephemeral, browser-based development environment that runs code-server inside an AWS Lambda MicroVM. A single developer uses a local TypeScript CLI to launch one MicroVM, connect to code-server from a local browser through a localhost-only authenticating reverse proxy, edit files and use the integrated terminal, explicitly suspend and resume the same session, and terminate the MicroVM safely.

The MVP is deliberately small: one user, one logical session, at most one active MicroVM. There is no deployed control plane. The CLI calls the Lambda MicroVMs APIs directly with the user's own short-lived AWS credentials. AWS CDK is used only for persistent infrastructure (MicroVM image build inputs and least-privilege IAM roles).

Pure lifecycle/domain logic is separated from AWS integration so that lifecycle invariants can be verified with property-based tests (fast-check) without AWS access.

Facts about Lambda MicroVMs behavior are listed in the "Assumptions and Open Questions" section with stable IDs (A-n, Q-n) and a verification status (Verified, Partially verified, Contradicted, Unverified) with sources. Requirements that depend on them reference those IDs. Design and tasks MUST re-validate any item that is not Verified against AWS primary documentation or a real environment before relying on it.

### Non-Goals

- Multi-user support, Amazon Cognito, Amazon CloudFront, highly available gateways, billing.
- Complex workspace persistence beyond what MicroVM suspend/resume provides.
- Large-scale orchestration or a deployed control plane (no API Gateway, no DynamoDB).
- Idle auto-suspend and auto-resume.
- Speculative abstractions for future providers.

### Conventions

- Acceptance criteria are referenced as `R<requirement>.<criterion>` (for example, R3.2).
- `[PBT]` marks a criterion suitable for property-based testing against the pure Lifecycle_Core with fast-check.
- `[EX]` marks a criterion verified by example-based unit or integration tests (including tests with a mocked AWS_Adapter).
- `[ENV]` marks a criterion that requires verification in a real AWS environment; such verification is manual or opt-in and costs money.
- `(depends on A-n / Q-n)` marks a dependency on an assumption or open question; check the item's verification status in "Assumptions and Open Questions".

## Glossary

- **CLI**: The local TypeScript command-line program, run via `pnpm`, that the User invokes to manage the Session.
- **User**: The single developer operating the CLI on a local workstation.
- **Lifecycle_Core**: The pure TypeScript module containing the Session state model, the transition function, and invariant checks. The Lifecycle_Core has no dependency on the AWS SDK, the file system, the network, or the clock.
- **AWS_Adapter**: The CLI module that calls the Lambda MicroVMs APIs (RunMicrovm, GetMicrovm, ListMicrovms, SuspendMicrovm, ResumeMicrovm, TerminateMicrovm, CreateMicrovmAuthToken) through `@aws-sdk/client-lambda-microvms`.
- **MicroVM**: One AWS Lambda MicroVM instance, identified by a MicroVM ID assigned by AWS.
- **Session**: The single logical development session managed by the CLI. A Session has a stable Session_ID and is bound to at most one MicroVM ID over the Session's life.
- **Session_ID**: A locally generated unique identifier for a Session, created at launch time or at adoption (R9.4). The Session_ID is stored only in the State_File; AWS does not store it, so the Session_ID cannot be recovered from AWS if the State_File is lost (see A-3).
- **Session_Marker**: The property that identifies a MicroVM as belonging to this project: the MicroVM runs the project's own Image ARN. The CLI detects Session_Marker MicroVMs by calling ListMicrovms filtered by imageIdentifier set to the project Image ARN (see A-3).
- **Remote_Status**: The MicroVM status reported by GetMicrovm or ListMicrovms: `PENDING`, `RUNNING`, `SUSPENDING`, `SUSPENDED`, `TERMINATING`, or `TERMINATED` (see A-1). Remote_Status is eventually consistent.
- **Session_State**: One of the logical states of a Session: `NONE`, `LAUNCHING`, `RUNNING`, `SUSPENDING`, `SUSPENDED`, `RESUMING`, `TERMINATING`, `TERMINATED`, `FAILED`.
- **In_Flight_State**: One of the Session_States `LAUNCHING`, `SUSPENDING`, `RESUMING`, or `TERMINATING`, entered by the CLI when a mutating AWS call has been issued and the expected Remote_Status has not yet been observed.
- **In_Flight_Timeout**: The configurable maximum time the Session may stay in `LAUNCHING` (launch timeout, default 300 seconds), `SUSPENDING` (suspend timeout, default 300 seconds), or `RESUMING` (resume timeout, default 300 seconds), measured from the mutating AWS call.
- **Readiness_Probe**: An HTTP request sent by the CLI to the MicroVM_Endpoint with a valid Auth_Token, targeting the code-server health path on the Code_Server_Port. The Readiness_Probe succeeds when the response status is 2xx.
- **Launch_Client_Token**: A unique value of 1 to 128 characters generated by the CLI for one launch attempt, persisted in the State_File before RunMicrovm is called, and passed to RunMicrovm as clientToken (see A-11).
- **Active_MicroVM**: A MicroVM whose Remote_Status is any status other than `TERMINATED` (see A-1).
- **State_File**: The gitignored local JSON file (default path `.session/state.json`) that caches the Session record. AWS is the source of truth for MicroVM existence and Remote_Status; the State_File is the only record of the Session_ID and the local-only Session_States.
- **Reconciler**: The CLI component that compares the State_File with the results of GetMicrovm and ListMicrovms and produces a reconciled Session record.
- **Stray_MicroVM**: An Active_MicroVM that carries the Session_Marker (runs the project Image ARN) and whose MicroVM ID differs from the MicroVM ID recorded in the reconciled Session.
- **Network_Connector**: An AWS-managed Lambda MicroVMs network connector passed to RunMicrovm. This project uses the AWS-managed `ALL_INGRESS` and `INTERNET_EGRESS` connectors (see Q-3).
- **Auth_Proxy**: The localhost-only reverse proxy run by the CLI that forwards browser HTTP and WebSocket traffic to the MicroVM endpoint and injects the Auth_Token.
- **Auth_Token**: The JWE token returned by CreateMicrovmAuthToken, scoped by expiration and allowed ports.
- **MicroVM_Endpoint**: The public HTTPS endpoint that AWS assigns to a MicroVM.
- **Image**: The Lambda MicroVM image containing code-server and the lifecycle hook handlers.
- **Hook_Handler**: The process inside the Image that serves the lifecycle hooks `POST /aws/lambda-microvms/runtime/v1/{run,resume,suspend,terminate}` and the image-build hooks `/ready` and `/validate`.
- **Code_Server_Port**: The TCP port on which code-server listens inside the MicroVM (default 8080).
- **Infrastructure_Stack**: The AWS CDK application that defines persistent infrastructure only: the S3 asset holding the Image build context (a zip containing a Dockerfile), the Image_Build_Role, the Image resource (CDK L1 `CfnMicrovmImage`, CloudFormation type `AWS::Lambda::MicrovmImage`), and IAM roles or policies.
- **Image_Build_Role**: The IAM role assumable by the `lambda.amazonaws.com` service principal that the Image build uses to read the build context from S3 (see A-12).
- **Execution_Role**: The IAM role passed as executionRoleArn to RunMicrovm, if any (see Q-4).
- **Operator_Policy**: The least-privilege IAM policy describing the permissions the User's short-lived credentials need to run the CLI.
- **Confirmation_Prompt**: An interactive prompt in the CLI that requires the User to explicitly approve a costly or destructive operation.
- **Retryable_Error**: An AWS error classified as transient: ThrottlingException and InternalServerException.

## Requirements

### Requirement 1: Explicit Session Lifecycle Model

**User Story:** As the User, I want the session lifecycle to be modeled explicitly, so that invalid operations are rejected before any AWS call is made.

#### Acceptance Criteria

1. THE Lifecycle_Core SHALL define the Session_State set as exactly `NONE`, `LAUNCHING`, `RUNNING`, `SUSPENDING`, `SUSPENDED`, `RESUMING`, `TERMINATING`, `TERMINATED`, and `FAILED`, classified as remote-backed (`RUNNING`, `SUSPENDING`, `SUSPENDED`, `TERMINATING`, `TERMINATED`, each having a Remote_Status of the same name) or local-only (`NONE`, `LAUNCHING`, `RESUMING`, `FAILED`, having no Remote_Status of the same name). [EX] (depends on A-1)
2. THE Lifecycle_Core SHALL define the permitted user-initiated transitions as: `launch` from `NONE` or `TERMINATED` to `LAUNCHING`; `suspend` from `RUNNING` to `SUSPENDING`; `resume` from `SUSPENDED` to `RESUMING`; `terminate` from `LAUNCHING`, `RUNNING`, `SUSPENDING`, `SUSPENDED`, `RESUMING`, or `FAILED` to `TERMINATING`; and `terminate` from `TERMINATING` to `TERMINATING` (a self-loop that re-issues TerminateMicrovm, supporting the retry in R8.5). [PBT]
3. WHEN a user-initiated command is requested in a Session_State for which the command is not a permitted transition, THE Lifecycle_Core SHALL return a rejection result that names the current Session_State and the requested command, and SHALL leave the Session unchanged. [PBT]
4. WHEN the Lifecycle_Core rejects a command, THE CLI SHALL make zero mutating AWS calls (RunMicrovm, SuspendMicrovm, ResumeMicrovm, TerminateMicrovm) for that command. [PBT]
5. THE Lifecycle_Core SHALL treat `TERMINATED` as a state from which `suspend` and `resume` are rejected. [PBT]
6. THE Lifecycle_Core SHALL compute transitions as a pure function of the current Session record and an input event, producing identical output for identical input. [PBT]
7. THE Lifecycle_Core SHALL map each Remote_Status to exactly one Session_State through a total mapping function (`PENDING` → `LAUNCHING`, `RUNNING` → `RUNNING`, `SUSPENDING` → `SUSPENDING`, `SUSPENDED` → `SUSPENDED`, `TERMINATING` → `TERMINATING`, `TERMINATED` → `TERMINATED`), mapping unrecognized status values to `FAILED` with the raw status preserved. [PBT] (depends on A-1)
8. THE Lifecycle_Core SHALL enter `FAILED` only from `LAUNCHING` or `RESUMING` (as defined in R2.6, R2.7, and R9.11) or through the unrecognized-status mapping in R1.7. [PBT] (depends on A-1)

### Requirement 2: Launch a MicroVM

**User Story:** As the User, I want to launch a MicroVM running code-server with one command, so that I can start working in a browser.

#### Acceptance Criteria

1. WHEN the User runs the launch command and the Confirmation_Prompt is approved, THE CLI SHALL call RunMicrovm with the configured project Image ARN, the configured maximumDurationInSeconds, the Launch_Client_Token, and the Network_Connectors defined in R2.8. [EX] (depends on A-3, A-11)
2. WHEN the User runs the launch command, THE CLI SHALL generate a new Session_ID and record the Session in the State_File with Session_State `LAUNCHING` before reporting success to the User. [EX]
3. WHEN RunMicrovm returns a MicroVM ID, THE CLI SHALL record the MicroVM ID in the State_File within the same command invocation. [EX]
4. WHILE the Session_State is `LAUNCHING`, WHEN the Remote_Status is `RUNNING` and the Readiness_Probe succeeds, THE CLI SHALL set the Session_State to `RUNNING` and print the local Auth_Proxy base URL and a hint to run the connect command to the User; the authenticated one-time login URL is printed by the connect command (R4.11). [EX] [ENV] (depends on A-1, A-5, Q-6)
5. THE CLI SHALL call RunMicrovm with an idlePolicy in which every field is set, autoResumeEnabled is false, and maxIdleDurationSeconds is greater than or equal to both 60 and the configured maximumDurationInSeconds, so that idle suspend does not trigger before the maximum duration ends. [EX] (depends on A-6)
6. IF RunMicrovm returns ServiceQuotaExceededException, InsufficientCapacityException, ResourceNotFoundException, or ValidationException, THEN THE CLI SHALL report the error name and message to the User, set the Session_State to `FAILED` when a MicroVM ID was recorded, return the Session to `NONE` and remove the State_File when no MicroVM ID was recorded, and exit with a non-zero exit code. [EX]
7. IF the Session_State remains `LAUNCHING` with a MicroVM ID recorded when the launch In_Flight_Timeout expires, THEN THE CLI SHALL set the Session_State to `FAILED`, report the timeout and the last observed Remote_Status to the User, and leave the MicroVM for the User to terminate explicitly. [EX]
8. THE CLI SHALL pass the AWS-managed `ALL_INGRESS` Network_Connector (required for the MicroVM_Endpoint) and the AWS-managed `INTERNET_EGRESS` Network_Connector (required for extension and package installation) explicitly to RunMicrovm, with both connector ARNs overridable through CLI configuration. [EX] (depends on Q-3)
9. WHERE the CLI passes a runHookPayload to RunMicrovm, THE CLI SHALL limit the runHookPayload to at most 4096 bytes, include only the Session_ID for in-VM logging, and exclude credentials and Auth_Tokens. [EX] (depends on A-3, A-11)

### Requirement 3: Single Active MicroVM per Session

**User Story:** As the User, I want one logical session to control at most one active MicroVM, so that I do not accidentally pay for or lose track of extra VMs.

#### Acceptance Criteria

1. THE Lifecycle_Core SHALL bind a Session to at most one MicroVM ID for the full life of the Session. [PBT]
2. WHILE the reconciled Session has an Active_MicroVM, THE Lifecycle_Core SHALL reject the launch command. [PBT]
3. FOR ALL sequences of commands and Remote_Status events applied to the Lifecycle_Core, THE Lifecycle_Core SHALL hold the invariant that the number of Active_MicroVMs bound to the Session is zero or one. [PBT]
4. WHEN the Reconciler detects one or more Stray_MicroVMs (Active_MicroVMs on the project Image ARN, other than the MicroVM recorded in the reconciled Session, found through ListMicrovms filtered by imageIdentifier), THE CLI SHALL list each Stray_MicroVM ID and Remote_Status to the User and reject the launch command until the User terminates the Stray_MicroVMs. [EX] (depends on A-3)
5. WHEN a Session reaches `TERMINATED` and the User launches again, THE Lifecycle_Core SHALL create a new Session with a new Session_ID. [PBT]

### Requirement 4: Connect from the Browser Through the Auth_Proxy

**User Story:** As the User, I want to open code-server in my local browser without ever handling the auth token, so that the MicroVM is never reachable without authentication.

#### Acceptance Criteria

1. WHILE the Session_State is `RUNNING`, WHEN the User runs the connect command, THE Auth_Proxy SHALL listen on the loopback interface (127.0.0.1) only, on a configurable port. [EX]
2. WHEN the Auth_Proxy receives an HTTP request from the browser, THE Auth_Proxy SHALL forward the request to the MicroVM_Endpoint with the Auth_Token in the `X-aws-proxy-auth` header and the `X-aws-proxy-port` header set to the Code_Server_Port. [EX] [ENV] (depends on A-4, A-5)
3. WHEN the Auth_Proxy receives a WebSocket upgrade request from the browser, THE Auth_Proxy SHALL open the upstream WebSocket with the subprotocols `lambda-microvms`, `lambda-microvms.authentication.<token>`, and `lambda-microvms.port.<Code_Server_Port>`, and SHALL relay frames in both directions. [EX] [ENV] (depends on A-5)
4. THE Auth_Proxy SHALL remove the Auth_Token from every response, header, and log line sent to the browser or written to the terminal. [EX]
5. THE CLI SHALL hold the Auth_Token in process memory only and SHALL exclude the Auth_Token from the State_File. [EX]
6. WHEN the remaining lifetime of the Auth_Token falls below a configurable refresh margin (default 60 seconds), THE Auth_Proxy SHALL obtain a new Auth_Token from CreateMicrovmAuthToken before forwarding further requests. [EX]
7. THE CLI SHALL request each Auth_Token with allowedPorts restricted to the single Code_Server_Port and with an expiration no longer than a configurable maximum (default 15 minutes). [EX] (depends on A-8)
8. IF CreateMicrovmAuthToken fails, THEN THE Auth_Proxy SHALL return HTTP 502 to the browser with a message that excludes token material, and SHALL report the error to the User's terminal. [EX]
9. WHILE the Session_State is any state other than `RUNNING`, THE Auth_Proxy SHALL return HTTP 503 to the browser with the current Session_State in the response body. [EX]
10. IF the configured maximum Auth_Token expiration is outside the range 1 to 60 minutes inclusive, THEN THE CLI SHALL reject the configuration with a validation error before any AWS call. [PBT] (depends on A-8)
11. WHEN the User runs the connect command, THE CLI SHALL print a one-time login URL containing a newly generated 256-bit secret; WHEN the browser first uses the login URL, THE Auth_Proxy SHALL set an `HttpOnly; SameSite=Strict` session cookie and invalidate the secret; IF a request lacks a valid session cookie, THEN THE Auth_Proxy SHALL return HTTP 401; WHERE the configuration sets `proxy.localAuth` to false, THE CLI SHALL disable this local authentication and print a warning to the User. [EX] (depends on Q-1)
12. IF a request's `Host` header is neither `127.0.0.1:<port>` nor `localhost:<port>` for the Auth_Proxy port, or a WebSocket upgrade request's `Origin` header does not match the Auth_Proxy origin, THEN THE Auth_Proxy SHALL reject the request; THE Auth_Proxy SHALL strip the local session cookie from every request before forwarding the request to the MicroVM_Endpoint. [EX] (depends on Q-1)

### Requirement 5: Edit Files and Use the Integrated Terminal

**User Story:** As the User, I want to edit files and use the integrated terminal in code-server, so that the environment is usable for real development work.

#### Acceptance Criteria

1. WHILE the Session_State is `RUNNING`, WHEN the User opens the Auth_Proxy URL, THE Auth_Proxy SHALL serve the code-server workbench UI to the browser. [ENV] (depends on A-9)
2. WHILE the Session_State is `RUNNING`, WHEN the User saves a file in code-server, THE MicroVM SHALL persist the file to the MicroVM disk so that reopening the file shows the saved content. [ENV]
3. WHILE the Session_State is `RUNNING`, WHEN the User opens the integrated terminal, THE Auth_Proxy SHALL relay terminal input and output between the browser and code-server over WebSocket. [ENV] (depends on A-9)
4. THE Image SHALL configure code-server with its own authentication disabled, relying on MicroVM_Endpoint JWE authentication as the only access control. [EX] (depends on A-4, Q-1)

### Requirement 6: Suspend the Session

**User Story:** As the User, I want to suspend my session explicitly, so that I stop compute charges while keeping my work.

#### Acceptance Criteria

1. WHILE the Session_State is `RUNNING`, WHEN the User runs the suspend command, THE CLI SHALL call SuspendMicrovm for the MicroVM ID recorded in the Session and set the Session_State to `SUSPENDING`. [EX]
2. WHILE the Session_State is `SUSPENDING`, WHEN the Remote_Status is `SUSPENDED`, THE CLI SHALL set the Session_State to `SUSPENDED`. [EX] [ENV]
3. WHEN the Session transitions from `RUNNING` through `SUSPENDING` to `SUSPENDED`, THE Lifecycle_Core SHALL keep the Session_ID and the MicroVM ID unchanged. [PBT]
4. WHEN the CLI calls SuspendMicrovm, THE Auth_Proxy SHALL stop forwarding new requests and SHALL respond as defined in R4.9. [EX]
5. IF SuspendMicrovm returns ConflictException (HTTP 409) indicating the MicroVM is not in a suspendable state, THEN THE CLI SHALL reconcile the Session with GetMicrovm and report the reconciled Session_State to the User. [EX] (depends on A-7)

### Requirement 7: Resume the Same Session

**User Story:** As the User, I want to resume the suspended session, so that I continue with the same files, terminal state, and identity.

#### Acceptance Criteria

1. WHILE the Session_State is `SUSPENDED`, WHEN the User runs the resume command, THE CLI SHALL call ResumeMicrovm for the MicroVM ID recorded in the Session and set the Session_State to `RESUMING`. [EX]
2. WHILE the Session_State is `RESUMING`, WHEN the Remote_Status is `RUNNING` and the Readiness_Probe succeeds, THE CLI SHALL set the Session_State to `RUNNING`. [EX] [ENV] (depends on A-1, A-5)
3. WHEN the Session transitions from `SUSPENDED` through `RESUMING` to `RUNNING`, THE Lifecycle_Core SHALL keep the Session_ID and the MicroVM ID unchanged. [PBT]
4. FOR ALL sequences of suspend and resume cycles, THE Lifecycle_Core SHALL preserve the Session_ID and the MicroVM ID that were assigned at launch. [PBT]
5. WHEN a resumed Session reaches `RUNNING`, THE file content saved before the suspend SHALL be present on the MicroVM disk. [ENV] (depends on A-10)
6. IF ResumeMicrovm returns an error indicating the MicroVM is not in a resumable state, THEN THE CLI SHALL reconcile the Session with GetMicrovm and report the reconciled Session_State to the User. [EX] (depends on A-7)

### Requirement 8: Terminate Safely

**User Story:** As the User, I want terminate to be safe and retryable, so that I can always stop costs without worrying about partial failures.

#### Acceptance Criteria

1. WHEN the User runs the terminate command and the Confirmation_Prompt is approved, THE CLI SHALL call TerminateMicrovm for the MicroVM ID recorded in the Session and set the Session_State to `TERMINATING`. [EX]
2. WHEN the remote MicroVM status reaches terminated, or GetMicrovm returns ResourceNotFoundException for the recorded MicroVM ID, THE CLI SHALL set the Session_State to `TERMINATED`. [EX] (depends on A-2)
3. FOR ALL Sessions, THE Lifecycle_Core SHALL produce the same final Session_State when the terminate command is applied once or applied two or more times in succession (idempotent terminate). [PBT]
4. WHEN the User runs the terminate command while the Session_State is already `TERMINATED`, THE CLI SHALL report that the Session is already terminated and exit with exit code 0. [EX]
5. IF TerminateMicrovm fails with a Retryable_Error, THEN THE CLI SHALL keep the Session_State as `TERMINATING` and report that the terminate command can be retried. [EX]
6. WHEN the terminate command completes, THE Auth_Proxy SHALL stop and release its listening port. [EX]
7. WHERE a Stray_MicroVM ID is given to the terminate command, THE CLI SHALL verify through ListMicrovms that the MicroVM runs the project Image ARN, and SHALL terminate the Stray_MicroVM after a Confirmation_Prompt naming that MicroVM ID, without changing the reconciled Session. [EX] (depends on A-3)
8. WHEN the User runs the terminate command while the Session_State is `LAUNCHING` and no MicroVM ID is recorded, THE CLI SHALL set the Session_State to `TERMINATING` while keeping the Launch_Client_Token, call RunMicrovm with the persisted Launch_Client_Token to recover the MicroVM ID (R12.6), record the MicroVM ID, and then call TerminateMicrovm for that MicroVM ID; IF that RunMicrovm call fails with a non-retryable error, THEN THE CLI SHALL return the Session to `NONE` and remove the State_File, as in R2.6. [EX] (depends on A-11)

### Requirement 9: Local State File and Reconciliation with AWS

**User Story:** As the User, I want the CLI to treat AWS as the source of truth, so that a stale or missing local file never causes a wrong action.

#### Acceptance Criteria

1. WHEN any CLI command starts, THE Reconciler SHALL read the State_File, call GetMicrovm for the recorded MicroVM ID, call ListMicrovms filtered by imageIdentifier set to the project Image ARN to find MicroVMs carrying the Session_Marker, and produce a reconciled Session before the command is evaluated. [EX] (depends on A-3)
2. WHEN the Session_State mapped (R1.7) from the Remote_Status reported by GetMicrovm differs from the Session_State in the State_File, THE Reconciler SHALL adopt the mapped Session_State, except where R9.9 through R9.12 keep a local In_Flight_State or `FAILED`. [PBT] (depends on A-1)
3. FOR ALL combinations of State_File content (absent, valid, or corrupt) and remote observations, THE Reconciler SHALL produce a reconciled Session that satisfies the invariant in R3.3. [PBT]
4. IF the State_File is absent and ListMicrovms returns exactly one Active_MicroVM carrying the Session_Marker, THEN THE Reconciler SHALL adopt that MicroVM into a new Session with a newly generated Session_ID, the MicroVM's ID, the Session_State mapped (R1.7) from the MicroVM's Remote_Status, and an `adopted` flag set to true; IF the State_File is absent and ListMicrovms returns two or more such Active_MicroVMs, THEN THE Reconciler SHALL report all of them as Stray_MicroVMs and leave the Session in `NONE` so that R3.4 rejects launch. [PBT] (depends on A-3)
5. IF the State_File content fails schema validation, THEN THE Reconciler SHALL rename the State_File with a `.corrupt-<timestamp>` suffix, report the condition to the User, and continue reconciliation as if the State_File were absent. [EX]
6. THE CLI SHALL write the State_File atomically by writing to a temporary file in the same directory and renaming the temporary file over the State_File. [EX]
7. THE State_File SHALL contain a schema version, the Session_ID, the MicroVM ID, the Session_State, the `adopted` flag, the Launch_Client_Token while the Session_State is `LAUNCHING` or while the Session_State is `TERMINATING` with no MicroVM ID recorded (R8.8), the start timestamp of the current In_Flight_State, the last reconciliation timestamp, and the AWS Region, and SHALL exclude Auth_Tokens and AWS credentials. [EX]
8. WHEN the User runs the status command, THE CLI SHALL print the reconciled Session_ID, MicroVM ID, Session_State, raw Remote_Status, the `adopted` flag, remaining maximum duration when known, and any Stray_MicroVM IDs. [EX]
9. WHILE the local Session_State is `LAUNCHING`, `SUSPENDING`, or `RESUMING` and the In_Flight_Timeout for that state has not expired, IF the Remote_Status still equals the pre-transition status (`PENDING`, or the recorded MicroVM ID not yet returned by GetMicrovm, for `LAUNCHING`; `RUNNING` for `SUSPENDING`; `SUSPENDED` for `RESUMING`), THEN THE Reconciler SHALL keep the local In_Flight_State. [PBT] (depends on A-1)
10. WHILE the local Session_State is `LAUNCHING` or `RESUMING`, WHEN the Remote_Status is `RUNNING`, THE Reconciler SHALL keep the local Session_State until the Readiness_Probe succeeds, as defined in R2.4 and R7.2. [PBT] (depends on A-1)
11. WHILE the local Session_State is `LAUNCHING` or `RESUMING` and a MicroVM ID is recorded, IF the Remote_Status is `TERMINATING` or `TERMINATED` without a user-initiated terminate, or the In_Flight_Timeout expires, THEN THE Reconciler SHALL set the Session_State to `FAILED` and preserve the raw Remote_Status. [PBT] (depends on A-1)
12. WHILE the local Session_State is `TERMINATING` or `FAILED`, THE Reconciler SHALL keep the local Session_State until the Remote_Status is `TERMINATED` or GetMicrovm returns ResourceNotFoundException for the recorded MicroVM ID, and SHALL then set the Session_State to `TERMINATED`. [PBT] (depends on A-1, A-2)

### Requirement 10: Confirmation for Costly and Destructive Operations

**User Story:** As the User, I want the CLI to ask before it spends money or destroys state, so that I never trigger a costly or irreversible action by accident.

#### Acceptance Criteria

1. WHEN the User runs the launch command, THE CLI SHALL display the Image ARN, AWS Region, and maximumDurationInSeconds in a Confirmation_Prompt and call RunMicrovm only after the User approves. [EX]
2. WHEN the User runs the terminate command, THE CLI SHALL display the MicroVM ID and a statement that unsaved MicroVM state will be lost in a Confirmation_Prompt and call TerminateMicrovm only after the User approves. [EX]
3. IF the User declines a Confirmation_Prompt, THEN THE CLI SHALL make zero mutating AWS calls and exit with exit code 0 after reporting the cancellation. [EX]
4. WHERE the User passes an explicit non-interactive confirmation flag (for example `--yes`), THE CLI SHALL treat the Confirmation_Prompt as approved. [EX]
5. IF standard input is not an interactive terminal and the explicit confirmation flag is absent, THEN THE CLI SHALL reject launch and terminate commands with a non-zero exit code. [EX]
6. THE Infrastructure_Stack documentation SHALL instruct the User to review `cdk diff` output before running `cdk deploy` or `cdk destroy`, and the project scripts SHALL exclude automatic approval flags for deploy and destroy. [EX]

### Requirement 11: Cost Bounds

**User Story:** As the User, I want hard upper bounds on MicroVM lifetime, so that a forgotten session cannot run up unbounded cost.

#### Acceptance Criteria

1. THE CLI SHALL pass maximumDurationInSeconds to RunMicrovm with a configurable value between 1 and 28800 inclusive and a default of 14400 (4 hours). [PBT] (depends on A-6)
2. IF the configured maximumDurationInSeconds is outside the range 1 to 28800, THEN THE CLI SHALL reject the configuration with a validation error before any AWS call. [PBT]
3. WHEN the status command runs while the Session_State is `SUSPENDED`, THE CLI SHALL inform the User that the suspended MicroVM continues to incur snapshot storage cost until terminated. [EX]

### Requirement 12: Error Handling and Retries

**User Story:** As the User, I want transient AWS errors handled predictably, so that commands are robust without hiding real failures.

#### Acceptance Criteria

1. IF an AWS call fails with a Retryable_Error, THEN THE AWS_Adapter SHALL retry the call with exponential backoff and jitter, up to a configurable maximum of attempts (default 5). [EX]
2. FOR ALL attempt numbers within the configured maximum, THE retry policy SHALL produce a delay that is non-negative, does not exceed a configurable cap, and does not decrease in its upper bound as the attempt number increases. [PBT]
3. IF an AWS call fails with a non-retryable error, THEN THE AWS_Adapter SHALL return the error to the CLI without retrying. [EX]
4. WHEN the CLI starts a launch attempt, THE CLI SHALL generate a new Launch_Client_Token, persist the Launch_Client_Token in the State_File before calling RunMicrovm, and THE AWS_Adapter SHALL pass the same Launch_Client_Token on every retry of RunMicrovm for that launch attempt, so that a retry cannot create a second MicroVM. [EX] (depends on A-11)
5. WHEN a CLI command fails, THE CLI SHALL exit with a non-zero exit code and print the AWS error name, the operation, and the MicroVM ID when known, without printing credentials or Auth_Tokens. [EX]
6. IF the State_File records Session_State `LAUNCHING` with a Launch_Client_Token and no MicroVM ID (for example after the CLI exited before RunMicrovm returned), THEN THE CLI SHALL call RunMicrovm again with the persisted Launch_Client_Token and the same parameters to obtain the MicroVM ID, instead of generating a new Launch_Client_Token. [EX] (depends on A-11)

### Requirement 13: MicroVM Image with code-server

**User Story:** As the User, I want a MicroVM image that starts code-server and handles lifecycle hooks, so that the MicroVM becomes usable as soon as it is running.

#### Acceptance Criteria

1. THE Image SHALL start code-server listening on the Code_Server_Port (default 8080). [ENV]
2. WHEN the Hook_Handler receives `POST /aws/lambda-microvms/runtime/v1/run`, THE Hook_Handler SHALL return HTTP 200 only after code-server responds successfully to a local health check on the Code_Server_Port, within the configured run hook timeout (1 to 60 seconds). [EX] [ENV] (depends on A-12)
3. WHEN the Hook_Handler receives the `resume`, `suspend`, or `terminate` lifecycle hook, THE Hook_Handler SHALL return HTTP 200 within a configurable timeout (default 10 seconds, allowed range 1 to 60 seconds). [EX] (depends on A-12)
4. WHEN the Hook_Handler receives the image-build `/ready` or `/validate` hook, THE Hook_Handler SHALL return HTTP 200 only after code-server is installed and starts successfully, within the configured ready or validate timeout (1 to 3600 seconds). [ENV] (depends on A-12)
5. THE Image SHALL contain zero AWS credentials, access keys, or session tokens. [EX]
6. THE Image SHALL pin the code-server version to an exact version number. [EX]

### Requirement 14: Persistent Infrastructure and Least-Privilege IAM

**User Story:** As the User, I want only the necessary persistent infrastructure defined in CDK with least-privilege IAM, so that the attack surface and cost stay minimal.

#### Acceptance Criteria

1. THE Infrastructure_Stack SHALL define only the S3 asset containing the Image build context (a zip with a Dockerfile), the Image_Build_Role, the Image as a `CfnMicrovmImage` (`AWS::Lambda::MicrovmImage`) resource, and IAM roles or policies required by the MicroVM workflow. [EX] (depends on A-12)
2. THE Operator_Policy SHALL grant only the Lambda MicroVMs actions used by the CLI (`lambda:RunMicrovm`, `lambda:GetMicrovm`, `lambda:ListMicrovms`, `lambda:SuspendMicrovm`, `lambda:ResumeMicrovm`, `lambda:TerminateMicrovm`, `lambda:CreateMicrovmAuthToken`), scoping MicroVM instance actions to the project Image ARN `arn:${Partition}:lambda:${Region}:${Account}:microvm-image:${Name}`, plus `iam:PassRole` limited to the Execution_Role ARN when an Execution_Role exists, plus `lambda:PassNetworkConnector` only if design verification shows RunMicrovm requires it for the Network_Connectors in R2.8. [EX] (depends on A-13, Q-4)
3. THE Infrastructure_Stack SHALL contain zero IAM statements with `Action: "*"` or `Resource: "*"`, except for actions that A-13 confirms support no resource-level scoping (`lambda:ListMicrovms`, and `lambda:PassNetworkConnector` when required), in which case the statement SHALL use `Resource: "*"` and SHALL be annotated with the justification. [EX] (depends on A-13)
4. WHERE an Execution_Role is defined, THE Execution_Role SHALL be assumable only by the Lambda MicroVMs service principal and SHALL have no permissions beyond those required by the Image (for example, log delivery). [EX] (depends on Q-4)
5. THE Infrastructure_Stack SHALL pass `cdk synth` and a snapshot or assertion test of the synthesized IAM statements. [EX]
6. THE Image_Build_Role SHALL be assumable only by the `lambda.amazonaws.com` service principal and SHALL grant read access only to the S3 object containing the Image build context. [EX] (depends on A-12)

### Requirement 15: Repository Hygiene and Secret Protection

**User Story:** As the User, I want the repository to keep secrets and local state out of version control, so that publishing the project does not leak credentials or tokens.

#### Acceptance Criteria

1. THE repository SHALL include a `.gitignore` that excludes the `.session/` directory, `.env` files, `cdk.out/`, `node_modules/`, and any file pattern used to store Auth_Tokens or credentials. [EX]
2. THE repository SHALL contain zero AWS access keys, secret keys, session tokens, or Auth_Tokens in tracked files. [EX]
3. THE repository SHALL provide a secret-scanning check (for example gitleaks) that runs locally before commit and in CI, and fails when a secret pattern is detected. [EX]
4. THE CLI SHALL obtain AWS credentials only from the standard AWS SDK credential provider chain and SHALL write AWS credentials to zero files. [EX]

### Requirement 16: Engineering Baseline and Testability

**User Story:** As the User, I want a consistent, reproducible toolchain and test suite, so that lifecycle correctness is verified automatically.

#### Acceptance Criteria

1. THE project SHALL be written in TypeScript and SHALL use pnpm as the only package manager, with `pnpm-lock.yaml` committed and a `packageManager` field in `package.json`. [EX]
2. THE project SHALL use Biome for linting and formatting, and `pnpm exec biome check` SHALL pass on the repository. [EX]
3. THE project SHALL provide a Nix flake devShell that supplies Node.js, pnpm, and the AWS CDK CLI at pinned versions. [EX]
4. THE Lifecycle_Core SHALL import zero modules from the AWS SDK, Node.js file-system, network, or process APIs. [EX]
5. THE project SHALL include fast-check property-based tests covering every acceptance criterion marked `[PBT]` in this document. [EX]
6. THE automated test suite SHALL run without AWS credentials and without network access, using a mocked AWS_Adapter for CLI behavior tests. [EX]
7. THE project SHALL document every `[ENV]` acceptance criterion as a manual or opt-in verification step, including its expected cost impact and the cleanup command. [EX]

## Assumptions and Open Questions

Each item carries a status from design research: **Verified** (confirmed in AWS documentation or SDK type definitions), **Partially verified**, **Contradicted** (the original assumption was wrong and the requirements were revised), or **Unverified**. Items that are not Verified MUST be re-validated against AWS primary documentation or a real environment during design or implementation. Verified documentation facts that drive `[ENV]` criteria still require real-environment confirmation. Design and tasks reference these IDs.

Primary sources used in design research: the Lambda MicroVMs developer guide ([How Lambda MicroVMs work](https://docs.aws.amazon.com/lambda/latest/dg/microvms-how-it-works.html)), the Lambda MicroVMs API reference, and the type definitions of `@aws-sdk/client-lambda-microvms` 3.1144.0.

### Assumptions

- **A-1 (Status enum) — Verified.** Remote_Status values are `PENDING`, `RUNNING`, `SUSPENDING`, `SUSPENDED`, `TERMINATING`, `TERMINATED`; there is no `RESUMING` or `FAILED` Remote_Status. During resume the MicroVM stays `SUSPENDED` until the `/resume` hook returns. If the `/run` hook fails, the MicroVM goes from `PENDING` directly to `TERMINATING`. GetMicrovm status is eventually consistent, and AWS recommends checking readiness by connecting to the endpoint. Consequences: `LAUNCHING`, `RESUMING`, and `FAILED` are local-only Session_States (R1.1); the Reconciler must not overwrite a local In_Flight_State only because the Remote_Status has not moved yet (R9.9–R9.12); readiness requires `RUNNING` plus a successful Readiness_Probe (R2.4, R7.2). Sources: `@aws-sdk/client-lambda-microvms` 3.1144.0 status enum; https://docs.aws.amazon.com/lambda/latest/dg/microvms-how-it-works.html.
- **A-2 (Terminate idempotency) — Partially verified.** Verified: TerminateMicrovm succeeds on an already-terminated MicroVM. Unverified: whether and for how long GetMicrovm keeps returning terminated MicroVMs (R8.2 therefore also accepts ResourceNotFoundException). Source: Lambda MicroVMs API reference (TerminateMicrovm).
- **A-3 (Session_Marker mechanism) — Contradicted.** RunMicrovm has no tags parameter, TagResource cannot target MicroVM instances, and neither ListMicrovms nor GetMicrovm returns tags or the runHookPayload. Revised Session_Marker: the MicroVM runs the project's own Image ARN, detected through ListMicrovms filtered by imageIdentifier (R3.4, R8.7, R9.1). Consequences: the Session_ID is local-only and cannot be recovered from AWS when the State_File is lost, so R9.4 adopts a single matching MicroVM into a new Session; any MicroVM started from the project Image outside the CLI is treated as part of this project. The Session_ID may be passed in runHookPayload for in-VM logging only (R2.9), never as a source of truth. The runHookPayload limit is inconsistent in AWS material (16 KB in prose, 4096 in the API constraint); this project uses at most 4096 bytes. Sources: Lambda MicroVMs API reference (RunMicrovm, TagResource, ListMicrovms, GetMicrovm); SDK 3.1144.0 types.
- **A-4 (Endpoint authentication) — Partially verified.** Documentation states that every request to the MicroVM_Endpoint requires a valid JWE token and there is no unauthenticated access option. Not verified beyond that statement (no real-environment test yet). This is the basis for disabling code-server's own password (R5.4). Pending Phase 0 (spike S3): if Phase 0 shows any unauthenticated 2xx response from the MicroVM_Endpoint, change R5.4 to enable code-server password authentication with the password injected by the Auth_Proxy.
- **A-5 (HTTP token transport) — Verified.** HTTP requests carry the token in the `X-aws-proxy-auth` header; `X-aws-proxy-port` selects the target port (default 8080); WebSocket connections use the subprotocols `lambda-microvms`, `lambda-microvms.authentication.<token>`, and `lambda-microvms.port.<port>` (R4.2, R4.3). Real-environment confirmation remains part of the `[ENV]` criteria. Source: Lambda MicroVMs developer guide (design research).
- **A-6 (RunMicrovm parameters) — Verified, requirement changed.** All idlePolicy fields are required and maxIdleDurationSeconds must be at least 60, so idle suspend cannot simply be omitted. R2.5 sets autoResumeEnabled to false and maxIdleDurationSeconds to at least maximumDurationInSeconds so idle suspend does not trigger. maximumDurationInSeconds is 1–28800 seconds, counting running and suspended time. Unverified: whether maxIdleDurationSeconds has an upper bound below 28800; if so, R2.5 cannot fully prevent idle suspend for long maximum durations and design must cap maximumDurationInSeconds or accept idle suspend. Pending Phase 0 (spike S8): if Phase 0 shows an upper bound `B < 28800` on maxIdleDurationSeconds, change R11.1 (and R11.2) to cap maximumDurationInSeconds at `B`. Source: Lambda MicroVMs API reference (RunMicrovm IdlePolicy); SDK 3.1144.0 types.
- **A-7 (Wrong-state errors) — Partially verified.** SuspendMicrovm and TerminateMicrovm document ConflictException (HTTP 409) for invalid state (R6.5). The error returned by ResumeMicrovm in an invalid state was not checked (R7.6 stays generic). Source: Lambda MicroVMs API reference.
- **A-8 (Token scoping) — Verified.** CreateMicrovmAuthToken accepts expirationInMinutes from 1 to 60, and allowedPorts as a list of `{port: N}` objects (R4.7, R4.10). Source: Lambda MicroVMs API reference (CreateMicrovmAuthToken).
- **A-9 (code-server over the proxy) — Unverified.** Whether code-server's WebSocket connections, service worker, and static asset paths work through the MicroVM_Endpoint and the Auth_Proxy (including long-lived WebSocket idle timeouts at the AWS proxy) is unverified.
- **A-10 (Suspend preserves disk and memory) — Unverified.** Suspend is documented to keep memory and disk. Whether open WebSocket connections and running terminal processes survive a suspend/resume cycle is unverified; the Auth_Proxy is expected to need reconnection after resume.
- **A-11 (RunMicrovm idempotency) — Verified.** RunMicrovm accepts a clientToken of 1–128 characters. The CLI uses a persisted Launch_Client_Token per launch attempt and reuses it on retries and after an interrupted launch (R12.4, R12.6). RunMicrovm also documents InsufficientCapacityException (R2.6). The exact response returned for a repeated clientToken should be confirmed in a real environment. Source: Lambda MicroVMs API reference (RunMicrovm).
- **A-12 (Image build pipeline) — Partially verified.** Verified: lifecycle hook timeouts are 1–60 seconds; `/ready` and `/validate` timeouts are 1–3600 seconds (R13.2–R13.4); the Image is built from a zip in S3 containing a Dockerfile plus a build role assumable by `lambda.amazonaws.com` (R14.1, R14.6); the CDK L1 construct `CfnMicrovmImage` (`AWS::Lambda::MicrovmImage`) exists. Unverified: the full build hook contract details, supported base images, and the minimum permissions of the build role. Pending Phase 0 (spike S1): if Phase 0 shows that the hooks must share the Code_Server_Port, change R13.1 so that an in-VM front process (the Hook_Handler) listens on the Code_Server_Port, serves the hook paths, and reverse-proxies all other traffic to code-server on an internal port. Sources: Lambda MicroVMs developer guide and AWS CDK/CloudFormation documentation (design research).
- **A-13 (IAM model) — Partially verified.** Verified: actions use the `lambda:` prefix (for example `lambda:RunMicrovm`); MicroVM instance actions are scoped to the Image ARN `arn:${Partition}:lambda:${Region}:${Account}:microvm-image:${Name}`; `lambda:ListMicrovms` supports no resource-level scoping and needs `Resource: "*"` with a justification; `lambda:PassNetworkConnector` supports no resource-level scoping. Unverified: whether RunMicrovm requires `lambda:PassNetworkConnector` for AWS-managed Network_Connectors (R14.2), and the resource scoping of CreateMicrovmAuthToken beyond the Image ARN pattern. Source: AWS IAM documentation for Lambda MicroVMs actions (design research).

### Open Questions

- **Q-1 (Local proxy exposure) — Resolved (design decision, user may override).** Original question: the Auth_Proxy listens on 127.0.0.1, so any local process or other local OS user could reach code-server through the proxy; accept as MVP risk or require a per-session secret? Decision: the Auth_Proxy requires a one-time login secret exchanged for an HttpOnly SameSite=Strict cookie, and checks `Host` and WebSocket `Origin` (R4.11, R4.12). Override: `proxy.localAuth: false` restores plain localhost access with a printed warning.
- **Q-2 (Region and Image selection) — Resolved (design decision, user may override); Region pending Phase 0.** Region and Image ARN come from a gitignored CLI configuration file, which a `config import` subcommand fills from the CDK outputs file. Phase 0 confirms which Region supports Lambda MicroVMs. Override: edit the configuration file by hand.
- **Q-3 (Egress) — Resolved as a decision (user may override).** AWS-managed `ALL_INGRESS` and `INTERNET_EGRESS` Network_Connector ARNs exist. Launch passes both explicitly (R2.8): `ALL_INGRESS` so the MicroVM_Endpoint is reachable (access control relies on JWE authentication, A-4), and `INTERNET_EGRESS` so extensions, packages, and git clones can be fetched. The connector ARNs are configurable so the User can restrict egress.
- **Q-4 (Execution_Role need) — Resolved (design decision, user may override); pending Phase 0.** No Execution_Role: RunMicrovm is called without executionRoleArn. Pending Phase 0 (spike S2): if Phase 0 shows an Execution_Role is required, the override becomes the default and R14.4 applies. Override: CDK context `withExecutionRole=true` adds the Execution_Role and an `iam:PassRole` statement, and the CLI reads `executionRoleArn` from configuration.
- **Q-5 (Workspace contents) — Resolved (design decision, user may override).** The workspace starts empty; code-server opens an empty workspace directory. Persistence beyond suspend/resume is a non-goal; files are lost on terminate. Override: add seed files to the Image build context.
- **Q-6 (Proxy lifecycle) — Resolved (design decision, user may override).** The Auth_Proxy runs only in the foreground of the connect command. Launch and resume print the Auth_Proxy base URL and a hint to run connect (R2.4); `launch --connect` hands off to connect.
