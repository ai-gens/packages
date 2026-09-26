use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread;

use ai_gens_packages_sdk::{compare_versions, Error, RegistryClient};
use sha2::{Digest, Sha256};

fn server(routes: HashMap<String, Vec<u8>>, requests: usize) -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}/registry/", listener.local_addr().unwrap());
    let handle = thread::spawn(move || {
        for _ in 0..requests {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 4096];
            let len = stream.read(&mut request).unwrap();
            let first_line = String::from_utf8_lossy(&request[..len]);
            let path = first_line.split_whitespace().nth(1).unwrap();
            let (status, body) = match routes.get(path) {
                Some(body) => ("200 OK", body.as_slice()),
                None => ("404 Not Found", b"missing".as_slice()),
            };
            write!(
                stream,
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            stream.write_all(body).unwrap();
        }
    });
    (base, handle)
}

#[test]
fn searches_checks_updates_and_downloads_verified_assets() {
    let bytes = b"verified archive";
    let mut routes: HashMap<String, Vec<u8>> = HashMap::new();
    let (base, server_handle) = {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/registry/", listener.local_addr().unwrap());
        let mut release: serde_json::Value =
            serde_json::from_str(include_str!("../../../packages/pt-buddy/latest.json")).unwrap();
        release["assets"][0]["downloadUrl"] = format!("{base}archive").into();
        release["assets"][0]["size"] = bytes.len().into();
        release["assets"][0]["sha256"] = format!("{:x}", Sha256::digest(bytes)).into();
        routes.insert(
            "/registry/index.json".into(),
            include_bytes!("../../../index.json").to_vec(),
        );
        routes.insert(
            "/registry/packages/pt-buddy/latest.json".into(),
            serde_json::to_vec(&release).unwrap(),
        );
        routes.insert(
            "/registry/packages/pt-buddy/versions/0.1.3.json".into(),
            serde_json::to_vec(&release).unwrap(),
        );
        routes.insert("/registry/archive".into(), bytes.to_vec());
        let handle = thread::spawn(move || {
            for _ in 0..6 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0u8; 4096];
                let len = stream.read(&mut request).unwrap();
                let first_line = String::from_utf8_lossy(&request[..len]);
                let path = first_line.split_whitespace().nth(1).unwrap();
                let (status, body) = match routes.get(path) {
                    Some(body) => ("200 OK", body.as_slice()),
                    None => ("404 Not Found", b"missing".as_slice()),
                };
                write!(
                    stream,
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .unwrap();
                stream.write_all(body).unwrap();
            }
        });
        (base, handle)
    };
    let client = RegistryClient::with_base_url(base.trim_end_matches('/')).unwrap();
    let found = client.search("PT").unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].id, "pt-buddy");
    let latest = client.latest("pt-buddy").unwrap();
    assert_eq!(latest.version, "0.1.3");
    assert!(client.version("pt-buddy", "0.1.3").is_ok());
    assert!(client.check_update("pt-buddy", "0.1.2").unwrap().is_some());
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("archive.zip");
    client.download_asset(&latest.assets[0], &path).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert!(matches!(
        client.download_asset(&latest.assets[0], &path),
        Err(Error::Io(_))
    ));
    server_handle.join().unwrap();
}

#[test]
fn rejects_bad_checksum_without_leaving_a_file() {
    let mut routes = HashMap::new();
    routes.insert("/registry/archive".into(), b"wrong".to_vec());
    let (base, handle) = server(routes, 1);
    let asset = ai_gens_packages_sdk::Asset {
        name: "archive.zip".into(),
        os: "linux".into(),
        arch: "amd64".into(),
        target: None,
        size: 5,
        sha256: "0".repeat(64),
        download_url: format!("{base}archive"),
    };
    let dir = tempfile::tempdir().unwrap();
    let destination = dir.path().join("archive.zip");
    let error = RegistryClient::with_base_url(&base)
        .unwrap()
        .download_asset(&asset, &destination)
        .unwrap_err();
    assert!(matches!(error, Error::ChecksumMismatch { .. }));
    assert!(!destination.exists());
    handle.join().unwrap();
}

#[test]
fn checks_semver_precedence_and_rejects_unsafe_paths() {
    use std::cmp::Ordering::*;
    assert_eq!(
        compare_versions("1.0.0-alpha.2", "1.0.0-alpha.10").unwrap(),
        Less
    );
    assert_eq!(compare_versions("1.0.0", "1.0.0-rc.1").unwrap(), Greater);
    assert_eq!(compare_versions("1.0.0+new", "1.0.0+old").unwrap(), Equal);
    let client = RegistryClient::new().unwrap();
    assert!(matches!(
        client.latest("../secret"),
        Err(Error::InvalidInput(_))
    ));
    assert!(matches!(
        client.version("pt-buddy", "../latest"),
        Err(Error::InvalidInput(_))
    ));
}
