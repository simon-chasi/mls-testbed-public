//! mls-cli — long-running MLS client process (mls-rs 0.54)
//!
//! One process per simulated client. The TypeScript simulator spawns this binary and
//! communicates via newline-delimited JSON on stdin/stdout.
//!
//! Protocol:
//!   stdin  → one JSON command per line
//!   stdout → one JSON response per line (echoes the "id" field)
//!   stderr → debug/error logging (ignored by the simulator)
//!
//! First command MUST be "init". All subsequent commands are handled in order.
//!
//! Commands: init | generate_key_package | create_group | add_member | join_group
//!           | process_commit | remove_member | self_update | encrypt | decrypt | get_info

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use mls_rs::{
    client_builder::ClientBuilder,
    identity::{
        basic::{BasicCredential, BasicIdentityProvider},
        SigningIdentity,
    },
    CipherSuite, CipherSuiteProvider, CryptoProvider, ExtensionList, MlsMessage,
};
use mls_rs_codec::{MlsDecode, MlsEncode};
use mls_rs_crypto_rustcrypto::RustCryptoProvider;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

// ── Constants ──────────────────────────────────────────────────────────────────

const CS: CipherSuite = CipherSuite::CURVE25519_AES128;

// ── Helpers ────────────────────────────────────────────────────────────────────

type E = Box<dyn std::error::Error + Send + Sync>;

fn b64enc(b: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(b)
}

fn b64dec(v: &Value) -> Result<Vec<u8>, E> {
    let s = v.as_str().ok_or("expected base64 string")?;
    Ok(URL_SAFE_NO_PAD.decode(s)?)
}

fn encode_msg(msg: &MlsMessage) -> Result<(String, usize), E> {
    let bytes = msg.mls_encode_to_vec()?;
    let size = bytes.len();
    Ok((b64enc(&bytes), size))
}

fn decode_msg(v: &Value) -> Result<MlsMessage, E> {
    let bytes = b64dec(v)?;
    Ok(MlsMessage::mls_decode(&mut bytes.as_slice())?)
}

async fn respond(stdout: &mut tokio::io::Stdout, v: Value) {
    let mut s = serde_json::to_string(&v).unwrap();
    s.push('\n');
    stdout.write_all(s.as_bytes()).await.unwrap();
    stdout.flush().await.unwrap();
}

// ── Entry point ────────────────────────────────────────────────────────────────

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    let mut reader = BufReader::new(stdin);
    let mut buf = String::new();

    // ── 1. Read "init" ────────────────────────────────────────────────────────
    buf.clear();
    if reader.read_line(&mut buf).await.unwrap_or(0) == 0 {
        return;
    }
    let init: Value = match serde_json::from_str(buf.trim()) {
        Ok(v) => v,
        Err(e) => {
            respond(&mut stdout, json!({"id": null, "ok": false, "error": e.to_string()})).await;
            return;
        }
    };
    let init_id = init["id"].clone();

    if init["cmd"] != "init" {
        respond(&mut stdout, json!({"id": init_id, "ok": false, "error": "first command must be 'init'"})).await;
        return;
    }
    let client_id = match init["client_id"].as_str() {
        Some(s) => s.to_string(),
        None => {
            respond(&mut stdout, json!({"id": init_id, "ok": false, "error": "missing client_id"})).await;
            return;
        }
    };

    // ── 2. Build MLS client ───────────────────────────────────────────────────
    // Generate signature key pair via the cipher suite provider.
    let (secret_key, public_key) = {
        let crypto = RustCryptoProvider::new();
        // CryptoProvider and CipherSuiteProvider are both in scope via the use declarations above.
        let cs_provider = crypto
            .cipher_suite_provider(CS)
            .expect("CURVE25519_AES128 must be supported by RustCryptoProvider");
        cs_provider
            .signature_key_generate()
            .expect("signature key generation failed")
    };

    let credential = BasicCredential::new(client_id.as_bytes().to_vec());
    let signing_identity = SigningIdentity::new(credential.into_credential(), public_key);

    let client = ClientBuilder::new()
        .crypto_provider(RustCryptoProvider::new())
        .identity_provider(BasicIdentityProvider::new())
        .signing_identity(signing_identity, secret_key, CS)
        .build();

    respond(&mut stdout, json!({"id": init_id, "ok": true, "client_id": &client_id})).await;

    // ── 3. Command loop ───────────────────────────────────────────────────────
    // `group` is None until create_group / join_group. Rust infers the concrete type.
    let mut group = None;

    loop {
        buf.clear();
        match reader.read_line(&mut buf).await {
            Ok(0) => break,
            Ok(_) => {}
            Err(e) => { eprintln!("stdin error: {e}"); break; }
        }
        let trimmed = buf.trim().to_string();
        if trimmed.is_empty() { continue; }

        let cmd: Value = match serde_json::from_str(&trimmed) {
            Ok(v) => v,
            Err(e) => {
                respond(&mut stdout, json!({"id": null, "ok": false, "error": format!("JSON parse: {e}")})).await;
                continue;
            }
        };

        let id = cmd["id"].clone();
        let cmd_name = cmd["cmd"].as_str().unwrap_or("?").to_string();

        // Wrap dispatch in an async block so `?` propagates to `result`, not to main().
        let result: Result<Value, E> = (async {
            match cmd["cmd"].as_str().unwrap_or("") {

                // ── generate_key_package (sync in mls-rs 0.54) ────────────────
                "generate_key_package" => {
                    let kp: MlsMessage = client.generate_key_package_message(
                        ExtensionList::default(),
                        ExtensionList::default(),
                        None,
                    )?;
                    let (kp_b64, kp_size) = encode_msg(&kp)?;
                    Ok(json!({ "key_package": kp_b64, "key_package_size": kp_size }))
                }

                // ── create_group (sync in mls-rs 0.54) ───────────────────────
                "create_group" => {
                    let g = client.create_group(
                        ExtensionList::default(),
                        ExtensionList::default(),
                        None,
                    )?;
                    group = Some(g);
                    let g = group.as_ref().unwrap();
                    let epoch = g.current_epoch();
                    let member_count = g.roster().members_iter().count();
                    let gid = b64enc(g.group_id());
                    Ok(json!({ "group_id": gid, "epoch": epoch, "member_count": member_count }))
                }

                // ── add_member (inline add + commit) ──────────────────────────
                "add_member" => {
                    let g = group.as_mut().ok_or("not in a group")?;
                    let kp = decode_msg(&cmd["key_package"])?;
                    let out = g.commit_builder().add_member(kp)?.build()?;
                    g.apply_pending_commit()?;
                    let (commit_b64, commit_size) = encode_msg(out.commit_message())?;
                    let welcome = out.welcome_messages().first()
                        .ok_or("no welcome produced")?;
                    let (welcome_b64, welcome_size) = encode_msg(welcome)?;
                    Ok(json!({
                        "commit": commit_b64,  "commit_size": commit_size,
                        "welcome": welcome_b64, "welcome_size": welcome_size,
                        "epoch": g.current_epoch(),
                        "member_count": g.roster().members_iter().count()
                    }))
                }

                // ── join_group (sync in mls-rs 0.54) ─────────────────────────
                "join_group" => {
                    let welcome = decode_msg(&cmd["welcome"])?;
                    // None = ratchet tree is embedded; None = no MlsTime override
                    let (g, _) = client.join_group(None, &welcome, None)?;
                    group = Some(g);
                    let g = group.as_ref().unwrap();
                    let epoch = g.current_epoch();
                    let member_count = g.roster().members_iter().count();
                    let gid = b64enc(g.group_id());
                    Ok(json!({ "group_id": gid, "epoch": epoch, "member_count": member_count }))
                }

                // ── process_commit ────────────────────────────────────────────
                "process_commit" => {
                    let g = group.as_mut().ok_or("not in a group")?;
                    let commit = decode_msg(&cmd["commit"])?;
                    g.process_incoming_message(commit)
                        .map_err(|e| E::from(format!("InvalidCommit: {e}")))?;
                    Ok(json!({
                        "epoch": g.current_epoch(),
                        "member_count": g.roster().members_iter().count()
                    }))
                }

                // ── remove_member (inline remove + commit) ────────────────────
                "remove_member" => {
                    let g = group.as_mut().ok_or("not in a group")?;
                    let leaf_index = cmd["leaf_index"].as_u64().ok_or("leaf_index required")? as u32;
                    let out = g.commit_builder().remove_member(leaf_index)?.build()?;
                    g.apply_pending_commit()?;
                    let (commit_b64, commit_size) = encode_msg(out.commit_message())?;
                    Ok(json!({
                        "commit": commit_b64, "commit_size": commit_size,
                        "epoch": g.current_epoch(),
                        "member_count": g.roster().members_iter().count()
                    }))
                }

                // ── self_update (inline update + commit) ──────────────────────
                "self_update" => {
                    let g = group.as_mut().ok_or("not in a group")?;
                    let out = g.commit_builder().build()?;
                    g.apply_pending_commit()?;
                    let (commit_b64, commit_size) = encode_msg(out.commit_message())?;
                    Ok(json!({
                        "commit": commit_b64, "commit_size": commit_size,
                        "epoch": g.current_epoch(),
                        "member_count": g.roster().members_iter().count()
                    }))
                }

                // ── encrypt ───────────────────────────────────────────────────
                "encrypt" => {
                    let g = group.as_mut().ok_or("not in a group")?;
                    let pt = cmd["plaintext"].as_str().ok_or("plaintext required")?;
                    let ct: MlsMessage = g.encrypt_application_message(pt.as_bytes(), vec![])?;
                    let (ct_b64, ct_size) = encode_msg(&ct)?;
                    Ok(json!({ "ciphertext": ct_b64, "size": ct_size, "epoch": g.current_epoch() }))
                }

                // ── decrypt ───────────────────────────────────────────────────
                "decrypt" => {
                    let g = group.as_mut().ok_or("not in a group")?;
                    let ct = decode_msg(&cmd["ciphertext"])?;
                    match g.process_incoming_message(ct) {
                        Ok(received) => {
                            use mls_rs::group::ReceivedMessage;
                            match received {
                                ReceivedMessage::ApplicationMessage(app) => {
                                    let plaintext = String::from_utf8(app.data().to_vec())
                                        .unwrap_or_else(|_| b64enc(app.data()));
                                    Ok(json!({ "success": true, "plaintext": plaintext }))
                                }
                                _ => Err(E::from("not an application message")),
                            }
                        }
                        Err(_) => Ok(json!({ "success": false, "error": "DecryptionError" })),
                    }
                }

                // ── get_info ──────────────────────────────────────────────────
                "get_info" => {
                    let g = group.as_ref().ok_or("not in a group")?;
                    Ok(json!({
                        "epoch": g.current_epoch(),
                        "member_count": g.roster().members_iter().count()
                    }))
                }

                other => Err(E::from(format!("unknown command: '{other}'"))),
            }
        }).await;

        let resp = match result {
            Ok(mut v) => { v["id"] = id; v["ok"] = json!(true); v }
            Err(e) => {
                eprintln!("[{}] ERROR in cmd={}: {}", client_id, cmd_name, e);
                json!({"id": id, "ok": false, "error": e.to_string()})
            }
        };
        respond(&mut stdout, resp).await;
    }
}
