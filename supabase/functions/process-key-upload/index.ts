import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Hàm phụ trợ để phân tích nội dung CSV một cách an toàn
const parseCSV = (csvString: string): string[][] => {
    if (!csvString) return [];
    const rows: string[][] = [];
    let currentRow: string[] = [];
    let currentField = '';
    let inQuotes = false;
    const normalizedCsv = csvString.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    for (let i = 0; i < normalizedCsv.length; i++) {
        const char = normalizedCsv[i];
        if (inQuotes) {
            if (char === '"') {
                if (i + 1 < normalizedCsv.length && normalizedCsv[i + 1] === '"') {
                    currentField += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                currentField += char;
            }
        } else {
            switch (char) {
                case ',':
                    currentRow.push(currentField);
                    currentField = '';
                    break;
                case '\n':
                    currentRow.push(currentField);
                    rows.push(currentRow);
                    currentRow = [];
                    currentField = '';
                    break;
                case '"':
                    if (currentField.length === 0) {
                        inQuotes = true;
                    } else {
                        currentField += char;
                    }
                    break;
                default:
                    currentField += char;
            }
        }
    }
    if (currentRow.length > 0 || currentField.length > 0) {
        currentRow.push(currentField);
        rows.push(currentRow);
    }
    return rows;
};

// Hàm chính xử lý request
Deno.serve(async (req) => {
  try {
    const payload = await req.json();

    // **KIỂM TRA BẢO VỆ**: Đảm bảo payload hợp lệ từ webhook của storage.
    if (payload.type !== 'INSERT' || !payload.record || payload.record.bucket_id !== 'task-keys' || !payload.record.name) {
      console.log('Ignoring irrelevant webhook event:', payload);
      return new Response(JSON.stringify({ message: 'Ignoring irrelevant event' }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      });
    }

    const record = payload.record;
    const filePath = record.name;
    const taskId = filePath.split('.')[0];

    // **KIỂM TRA BẢO VỆ**: Bỏ qua các tệp giữ chỗ (placeholder) hoặc file không có tên hợp lệ.
    if (!taskId || taskId.trim() === '' || taskId.startsWith('.')) {
        console.log(`Ignoring file with invalid name: ${filePath}`);
        return new Response(JSON.stringify({ message: `Ignoring file with invalid name` }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        });
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const { data: file, error: downloadError } = await supabaseAdmin.storage
      .from('task-keys')
      .download(filePath);

    if (downloadError) throw downloadError;

    const csvContent = await file.text();
    const rows = parseCSV(csvContent);
    
    const startIndex = rows.length > 0 && rows[0][0].toLowerCase() === 'category_id' ? 1 : 0;
    const keyData = rows.slice(startIndex);
    
    if (keyData.length === 0) {
        console.warn(`Parsed empty key data from file: ${filePath}. Not updating database.`);
        return new Response(JSON.stringify({ message: `Parsed empty key data from file: ${filePath}` }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        });
    }

    if (keyData.some(row => row.length < 3)) {
        throw new Error("Malformed key file. Expected 'category_id,content,overall_band_score'.");
    }

    const { error: rpcError } = await supabaseAdmin.rpc('internal_upsert_task_key', {
      p_task_id: taskId,
      p_key_data: keyData,
    });

    if (rpcError) throw rpcError;

    return new Response(JSON.stringify({ message: `Successfully processed key for ${taskId}` }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    });
  } catch (error) {
    console.error('Error processing key upload:', error.message);
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});