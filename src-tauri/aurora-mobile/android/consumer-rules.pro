# Tauri calls the plugin's @Command methods and parses @InvokeArg classes by reflection.
-keep class app.aurora.mobile.** { *; }

# NewPipe Extractor (YouTube/SoundCloud) and the Rhino JavaScript engine it uses.
-keep class org.schabi.newpipe.extractor.** { *; }
-keep class org.mozilla.javascript.** { *; }
-keep class org.mozilla.classfile.ClassFileWriter
-dontwarn org.mozilla.javascript.tools.**
-dontwarn org.mozilla.javascript.engine.**
-dontwarn javax.script.**
-dontwarn java.beans.**
-dontwarn javax.annotation.**
-dontwarn org.jsoup.**
-dontwarn com.google.re2j.**
-dontwarn org.slf4j.**
# Rhino's optional "dynalink" optimizer uses desktop-Java-only classes; never used on Android.
-dontwarn jdk.dynalink.**
