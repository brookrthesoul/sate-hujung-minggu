const SUPABASE_URL =
'https://efrwvksxttauhoxllhqu.supabase.co';

const SUPABASE_KEY =
'sb_publishable_SOoDs65SPw_G_m-lZ6NP-w_MbbqxOUw';

const supabase =
window.supabase.createClient(
    SUPABASE_URL,
    SUPABASE_KEY
);

async function pushOrderToCloud(order) {

    const { error } = await supabase
        .from('orders')
        .upsert({
            id: order.id,
            data: order,
            updated_at: new Date().toISOString()
        });

    if (error) {
        console.error(error);
        throw error;
    }
}

async function pullOrdersFromCloud() {

    const { data, error } =
        await supabase
            .from('orders')
            .select('*');

    if (error) {
        console.error(error);
        throw error;
    }

    return data || [];
}

async function syncNow() {

    try {

        console.log('Sync started');

        const localOrders =
            await getAllOrders();

        for (const order of localOrders) {
            await pushOrderToCloud(order);
        }

        const cloudOrders =
            await pullOrdersFromCloud();

        for (const row of cloudOrders) {

            const existing =
                localOrders.find(
                    o => o.id === row.id
                );

            if (!existing) {
                await addOrder(row.data);
            }
        }

        alert('✅ Sync Complete');

    } catch (err) {

        console.error(err);

        alert(
            '❌ Sync Failed\n\n' +
            err.message
        );
    }
}
