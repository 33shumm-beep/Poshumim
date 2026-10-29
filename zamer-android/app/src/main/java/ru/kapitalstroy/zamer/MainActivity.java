package ru.kapitalstroy.zamer;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.core.content.FileProvider;
import androidx.webkit.WebViewAssetLoader;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

public class MainActivity extends Activity {
    private static final String START = "https://appassets.androidplatform.net/assets/index.html";
    private static final int REQ_FILE = 1;
    private WebView web;
    private ValueCallback<Uri[]> fileCb;
    private Uri camUri;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setTextZoom(100);
        s.setMediaPlaybackRequiresUserGesture(false);
        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this)).build();
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                return loader.shouldInterceptRequest(r.getUrl());
            }
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if ("appassets.androidplatform.net".equals(u.getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) {}
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (fileCb != null) fileCb.onReceiveValue(null);
                fileCb = cb;
                camUri = null;
                boolean image = false;
                for (String t : p.getAcceptTypes()) if (t != null && t.startsWith("image")) image = true;
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                pick.setType(image ? "image/*" : "*/*");
                Intent chooser;
                if (image) {
                    try {
                        File dir = new File(getCacheDir(), "cam");
                        dir.mkdirs();
                        File f = new File(dir, "ph_" + System.currentTimeMillis() + ".jpg");
                        camUri = FileProvider.getUriForFile(MainActivity.this, "ru.kapitalstroy.zamer.files", f);
                        Intent cam = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
                        cam.putExtra(MediaStore.EXTRA_OUTPUT, camUri);
                        cam.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        if (p.isCaptureEnabled()) {
                            chooser = cam;
                        } else {
                            chooser = Intent.createChooser(pick, "Выберите фото");
                            chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{cam});
                        }
                    } catch (Exception e) {
                        camUri = null;
                        chooser = Intent.createChooser(pick, "Выберите фото");
                    }
                } else {
                    chooser = Intent.createChooser(pick, "Выберите файл");
                }
                try {
                    startActivityForResult(chooser, REQ_FILE);
                } catch (Exception e) {
                    fileCb = null;
                    cb.onReceiveValue(null);
                    return false;
                }
                return true;
            }
        });
        web.addJavascriptInterface(new Bridge(this), "ZKS");
        if (state != null) web.restoreState(state);
        else web.loadUrl(START);
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req != REQ_FILE || fileCb == null) return;
        Uri[] out = null;
        if (res == RESULT_OK) {
            if (data != null && data.getData() != null) out = new Uri[]{data.getData()};
            else if (camUri != null) out = new Uri[]{camUri};
        }
        fileCb.onReceiveValue(out);
        fileCb = null;
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("(window.zksBack&&window.zksBack())?'1':'0'", v -> {
            if (!"\"1\"".equals(v)) MainActivity.super.onBackPressed();
        });
    }

    public class Bridge {
        private final Context ctx;
        Bridge(Context c) { ctx = c; }

        @JavascriptInterface
        public boolean saveFile(String name, String mime, String b64) {
            try {
                byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
                OutputStream os;
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues cv = new ContentValues();
                    cv.put(MediaStore.Downloads.DISPLAY_NAME, name);
                    cv.put(MediaStore.Downloads.MIME_TYPE, mime);
                    cv.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Замер КС");
                    Uri u = ctx.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                    os = ctx.getContentResolver().openOutputStream(u);
                } else {
                    File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Замер КС");
                    dir.mkdirs();
                    os = new FileOutputStream(new File(dir, name));
                }
                os.write(bytes);
                os.close();
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public void print(final String title) {
            runOnUiThread(() -> {
                PrintManager pm = (PrintManager) getSystemService(Context.PRINT_SERVICE);
                String t = (title == null || title.trim().isEmpty()) ? "Паспорт замера" : title.trim();
                pm.print(t, web.createPrintDocumentAdapter(t),
                        new PrintAttributes.Builder().setMediaSize(PrintAttributes.MediaSize.ISO_A4).build());
            });
        }
    }
}
