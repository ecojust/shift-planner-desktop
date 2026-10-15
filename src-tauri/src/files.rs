use std::path::Path;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

const EXPORT_LIMIT: usize = 12 * 1024 * 1024;
const IMPORT_LIMIT: u64 = 8 * 1024 * 1024;

fn export_extension(file_name: &str) -> Result<&str, String> {
    if file_name.is_empty() || file_name.len() > 200 || file_name.contains(['/', '\\', '\0']) {
        return Err("导出文件名不正确。".into());
    }
    let extension = Path::new(file_name)
        .extension()
        .and_then(|ext| ext.to_str())
        .ok_or("导出文件缺少扩展名。")?;
    if !matches!(extension, "xlsx" | "json" | "csv" | "txt") {
        return Err("不支持的导出文件类型。".into());
    }
    Ok(extension)
}

#[tauri::command]
pub async fn save_export(
    app: AppHandle,
    file_name: String,
    contents: Vec<u8>,
) -> Result<bool, String> {
    let extension = export_extension(&file_name)?.to_owned();
    if contents.len() > EXPORT_LIMIT {
        return Err("导出文件超过 12 MB 上限。".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let choice = app
            .dialog()
            .file()
            .set_file_name(&file_name)
            .add_filter("排班文件", &[extension.as_str()])
            .blocking_save_file();
        let Some(choice) = choice else {
            return Ok(false);
        };
        let mut path = choice
            .into_path()
            .map_err(|_| "无法写入所选位置，请选择本地文件夹。")?;
        if path.extension().is_none() {
            path.set_extension(&extension);
        }
        if path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase())
            != Some(extension)
        {
            return Err("保存文件的扩展名必须与导出类型一致。".into());
        }
        std::fs::write(path, contents).map_err(|error| format!("保存失败：{error}"))?;
        Ok(true)
    })
    .await
    .map_err(|_| "保存窗口异常关闭。".to_string())?
}

#[tauri::command]
pub async fn import_backup(app: AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let choice = app
            .dialog()
            .file()
            .add_filter("排班 JSON 文件", &["json"])
            .blocking_pick_file();
        let Some(choice) = choice else {
            return Ok(None);
        };
        let path = choice
            .into_path()
            .map_err(|_| "无法读取所选位置，请选择本地 JSON 文件。")?;
        if !path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
        {
            return Err("请选择 JSON 格式的排班文件。".into());
        }
        // Open once and cap the actual read too, so a file changing after metadata cannot exceed the limit.
        use std::io::Read;
        let file = std::fs::File::open(path).map_err(|error| format!("读取文件失败：{error}"))?;
        if file.metadata().map_err(|_| "无法读取文件大小。")?.len() > IMPORT_LIMIT {
            return Err("JSON 文件超过 8 MB 上限。".into());
        }
        let mut bytes = Vec::new();
        file.take(IMPORT_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "读取文件失败。")?;
        if bytes.len() as u64 > IMPORT_LIMIT {
            return Err("JSON 文件超过 8 MB 上限。".into());
        }
        let content =
            String::from_utf8(bytes).map_err(|_| "文件必须为 UTF-8 编码的 JSON。")?;
        Ok(Some(content))
    })
    .await
    .map_err(|_| "导入窗口异常关闭。".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn file_names_cannot_select_paths_or_executables() {
        assert_eq!(export_extension("排班表.xlsx").unwrap(), "xlsx");
        for invalid in [
            "../secret.json",
            "C:\\windows\\file.txt",
            "tool.exe",
            "",
            "file",
        ] {
            assert!(export_extension(invalid).is_err());
        }
    }
}
